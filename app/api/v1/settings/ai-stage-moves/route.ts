/**
 * GET  /api/v1/settings/ai-stage-moves — lê `organizations.settings.crm.ai_stage_moves`.
 * PATCH /api/v1/settings/ai-stage-moves — grava (admin only).
 *
 * O knob decide, por organização, se o agente MOVE o card sozinho quando avança
 * `lead_state` (`"auto"`, o padrão — compatível com toda instalação existente)
 * ou se ele SUGERE e espera confirmação humana (`"suggest"`). O portão real vive
 * em `lib/leads/stage-move-policy.ts` (regra pura) e em
 * `lib/leads/agent-stage-sync.ts` (onde o knob é lido antes do UPDATE);
 * `lib/organizacoes/ai-stage-moves.ts` é o vocabulário e a leitura fail-closed
 * compartilhados por rota e agente.
 *
 * Padrão idêntico a `app/api/v1/settings/nicho/route.ts`: admin client pro
 * UPDATE (a única policy de escrita de `organizations` é
 * `orgs_write_platform_admin`), merge não-destrutivo de `settings.crm`,
 * `organization_id` de fonte confiável (`requireRole`), nunca do body. `admin`
 * porque decidir se o funil anda sozinho é decisão de risco da organização
 * inteira — mesmo patamar do modo sombra e do nicho.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { aiStageMovesModeSchema, AI_STAGE_MOVES_DEFAULT } from "@/lib/organizacoes/ai-stage-moves";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const patchSchema = z.object({ mode: aiStageMovesModeSchema });

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "settings_ai_stage_moves" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: orgRow, error } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const settings = (orgRow?.settings as Record<string, unknown> | null) ?? {};
  const crm = (settings.crm as Record<string, unknown> | null) ?? {};
  const parsed = aiStageMovesModeSchema.safeParse(crm.ai_stage_moves ?? null);
  const mode = parsed.success ? parsed.data : AI_STAGE_MOVES_DEFAULT;
  return ok({ mode }, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "settings_ai_stage_moves" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(
      "validation_failed",
      "Envie { mode: 'auto' | 'suggest' }.",
      422,
      { requestId },
    );
  }

  // Escrita pelo admin client — ver o cabeçalho e o comentário gêmeo em
  // `settings/nicho/route.ts` e `settings/modo-sombra/route.ts`.
  const supabase = createAdminClient();
  const { data: orgRow, error: readErr } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  if (readErr) return fail("internal_error", readErr.message, 500, { requestId });

  const currentSettings = (orgRow?.settings as Record<string, unknown> | null) ?? {};
  const currentCrm = (currentSettings.crm as Record<string, unknown> | null) ?? {};
  const antes = aiStageMovesModeSchema.safeParse(currentCrm.ai_stage_moves ?? null).success
    ? (currentCrm.ai_stage_moves as string)
    : AI_STAGE_MOVES_DEFAULT;

  const nextSettings: Record<string, unknown> = {
    ...currentSettings,
    crm: { ...currentCrm, ai_stage_moves: parsed.data.mode },
  };

  const { error: updErr } = await supabase
    .from("organizations")
    .update({ settings: nextSettings })
    .eq("id", activeOrg.orgId);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  void audit({
    action: "crm.ai_stage_moves_changed",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId,
    metadata: { antes, depois: parsed.data.mode },
  });

  return ok({ mode: parsed.data.mode }, { requestId });
}
