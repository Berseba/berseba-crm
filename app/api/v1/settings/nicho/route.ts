/**
 * GET  /api/v1/settings/nicho — lê `organizations.settings.nicho`.
 * PATCH /api/v1/settings/nicho — grava (admin only).
 *
 * Berseba (BERSEBA.md, "Organization niche"). `saude` does two things:
 *  - arms the medical-emergency handoff (`checkG4Medical`,
 *    `lib/ai/handoff/medical-emergency.ts`), read on every turn through
 *    `lerNichoDaOrg`/`nichoEhSaude` (`lib/agent-engine/guardrails/camadas-da-org.ts`);
 *  - switches on upstream's `afirmacao_clinica` layer (the `clinical_claim` veto, with
 *    its fail-safe to a human) when the organization never chose it. An explicit
 *    choice — on or off, made in the agent's security panel — is never overwritten,
 *    and leaving `saude` never switches the layer off: from then on it is the
 *    organization's choice, shown and editable where upstream shows it. Issue
 *    Berseba/berseba-crm#35 replaced our own `clinical_scope` gate with this.
 *
 * The write lives in `lib/organizacoes/save-niche.ts`: one transaction on the raw pool
 * that merges the key in the UPDATE, so saving the niche never drops another key of
 * `settings` (issue Berseba/berseba-crm#37 — the other writers of `settings` are still
 * read-spread-write; see that file). The pool bypasses RLS, so `organization_id` comes from
 * `requireRole` (session), never from the body (anti-pattern 10). `admin` because it changes
 * what the AI may state on the organization's WhatsApp, the same bar as "Exigir de quem
 * administra".
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { nichoSchema } from "@/lib/organizacoes/nicho";
import { CLINICAL_CLAIM_LAYER, saveNiche, type SavedNiche } from "@/lib/organizacoes/save-niche";
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

  let pool: pg.Pool;
  try {
    pool = getRequestPool();
  } catch {
    return fail("unavailable", "Banco indisponível (configuração).", 503, { requestId });
  }

  let saved: SavedNiche | null;
  try {
    saved = await saveNiche(pool, activeOrg.orgId, parsed.data.nicho);
  } catch (err) {
    // The pg message can carry table and constraint names: log it, never return it.
    logger.error("[settings/nicho] save failed", {
      organization_id: activeOrg.orgId,
      request_id: requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail("internal_error", "Não foi possível salvar o nicho.", 500, { requestId });
  }
  if (saved === null) return fail("not_found", "Organização não encontrada.", 404, { requestId });

  void audit({
    action: "org.nicho_changed",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId,
    metadata: { antes: saved.previous, depois: parsed.data.nicho },
  });
  if (saved.clinicalClaimLayer === "enabled_now") {
    // Same action and shape as upstream's `PUT /api/v1/ai/guardrail-layers`, so the
    // trail of a layer reads the same whoever switched it on.
    void audit({
      action: "ai.guardrail_layer_changed",
      actorUserId: authUser.id,
      organizationId: activeOrg.orgId,
      resourceType: "org_guardrail_layers",
      resourceId: null,
      requestId,
      metadata: { layer: CLINICAL_CLAIM_LAYER, enabled: true, source: "niche" },
    });
  }

  return ok({ nicho: parsed.data.nicho, clinical_claim_layer: saved.clinicalClaimLayer }, { requestId });
}
