/**
 * GET  /api/v1/settings/modo-sombra — lê `organizations.settings.modo_sombra`.
 * PATCH /api/v1/settings/modo-sombra — liga/desliga (admin only).
 *
 * Modo sombra é o cinto de segurança ACIMA do agente (ver
 * `lib/ai/modo-sombra/regra.ts`): enquanto ligado, NENHUMA mensagem gerada por
 * IA sai para o WhatsApp desta organização — todo turno vira rascunho (ou é
 * pulado, nos caminhos sem rascunho possível), e só um humano aprova o envio.
 * Isto é uma decisão de risco da organização inteira, por isso `admin` — o
 * mesmo patamar de "Exigir de quem administra" em Configurações › Segurança
 * (`app/actions/auth/politicaDeMfa.ts`), não `manager` como o roteamento.
 *
 * Padrão idêntico a `app/api/v1/settings/routing/route.ts`: admin client pro
 * UPDATE (a única policy de escrita de `organizations` é
 * `orgs_write_platform_admin`, e um manager/admin comum casaria 0 linhas pelo
 * client de sessão — ver o comentário lá), merge não-destrutivo de `settings`,
 * `organization_id` de fonte confiável (`requireRole`), nunca do body.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const modoSombraPatchSchema = z.object({ modo_sombra: z.boolean() });

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "settings_modo_sombra" });
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
  return ok({ modo_sombra: settings.modo_sombra === true }, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "settings_modo_sombra" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  const parsed = modoSombraPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Envie { modo_sombra: boolean }.", 422, { requestId });
  }

  // Escrita pelo admin client — ver o cabeçalho do arquivo e o comentário
  // gêmeo em `settings/routing/route.ts`.
  const supabase = createAdminClient();
  const { data: orgRow, error: readErr } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  if (readErr) return fail("internal_error", readErr.message, 500, { requestId });

  const currentSettings = (orgRow?.settings as Record<string, unknown> | null) ?? {};
  const antes = currentSettings.modo_sombra === true;
  const nextSettings: Record<string, unknown> = { ...currentSettings, modo_sombra: parsed.data.modo_sombra };

  const { error: updErr } = await supabase
    .from("organizations")
    .update({ settings: nextSettings })
    .eq("id", activeOrg.orgId);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  void audit({
    action: "ai.modo_sombra_changed",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId,
    metadata: { escopo: "organizacao", antes, depois: parsed.data.modo_sombra },
  });

  return ok({ modo_sombra: parsed.data.modo_sombra }, { requestId });
}
