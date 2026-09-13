/**
 * GET  /api/v1/settings/nicho — lê `organizations.settings.nicho`.
 * PATCH /api/v1/settings/nicho — grava (admin only).
 *
 * O nicho da organização liga, hoje, os dois freios clínicos determinísticos:
 * `checkG4Medical` (urgência médica relatada pelo contato → handoff humano,
 * `lib/ai/handoff/triggers.ts`) e `clinicalScopeGate` (veto de diagnóstico,
 * prescrição e promessa de cura, `lib/agent-engine/guardrails/escopo-clinico.ts`)
 * — ambos armados só quando `settings->>'nicho' = 'saude'`, via
 * `lerNichoDaOrg`/`nichoEhSaude` (`lib/agent-engine/guardrails/camadas-da-org.ts`).
 * Antes desta rota não havia tela para gravar o valor — violava o invariante 6
 * da doutrina do sistema vivo ("toda configuração tem superfície",
 * `docs/doctrine/sistema-vivo.md`).
 *
 * Vocabulário fechado em `lib/organizacoes/nicho.ts` (fonte única, importada
 * também por `camadas-da-org.ts`) — `null` é "não escolheu" e não arma nada,
 * exatamente como toda organização se comportava antes de esta rota existir:
 * zero diferença para clones que não mexerem na tela.
 *
 * Padrão idêntico a `app/api/v1/settings/modo-sombra/route.ts`: admin client
 * pro UPDATE (a única policy de escrita de `organizations` é
 * `orgs_write_platform_admin` — um admin comum de tenant casaria 0 linhas pelo
 * client de sessão, ver o comentário gêmeo em `settings/routing/route.ts`),
 * merge não-destrutivo de `settings`, `organization_id` de fonte confiável
 * (`requireRole`), nunca do body. `admin` porque ligar/desligar um freio
 * clínico é decisão de risco da organização inteira, o mesmo patamar do modo
 * sombra e de "Exigir de quem administra" em Configurações › Segurança.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { nichoSchema } from "@/lib/organizacoes/nicho";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const nichoPatchSchema = z.object({ nicho: nichoSchema });

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "settings_nicho" });
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
  const nicho = nichoSchema.catch(null).parse(settings.nicho ?? null);
  return ok({ nicho }, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "settings_nicho" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  const parsed = nichoPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(
      "validation_failed",
      "Envie { nicho: 'saude' | 'ecommerce' | 'imobiliaria' | 'infoproduto' | 'servicos' | null }.",
      422,
      { requestId },
    );
  }

  // Escrita pelo admin client — ver o cabeçalho do arquivo e o comentário
  // gêmeo em `settings/modo-sombra/route.ts` e `settings/routing/route.ts`.
  const supabase = createAdminClient();
  const { data: orgRow, error: readErr } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  if (readErr) return fail("internal_error", readErr.message, 500, { requestId });

  const currentSettings = (orgRow?.settings as Record<string, unknown> | null) ?? {};
  const antes = nichoSchema.catch(null).parse(currentSettings.nicho ?? null);
  const nextSettings: Record<string, unknown> = { ...currentSettings, nicho: parsed.data.nicho };

  const { error: updErr } = await supabase
    .from("organizations")
    .update({ settings: nextSettings })
    .eq("id", activeOrg.orgId);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  void audit({
    action: "org.nicho_changed",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId,
    metadata: { antes, depois: parsed.data.nicho },
  });

  return ok({ nicho: parsed.data.nicho }, { requestId });
}
