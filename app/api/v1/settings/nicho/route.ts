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
 * The write is ONE transaction on the raw pool (issue Berseba/berseba-crm#37): the key
 * is merged into `settings` by the UPDATE itself (`settings || jsonb_build_object`),
 * never read, spread and written back — a concurrent write to another key of
 * `settings` (the MFA policy saved from the same screen) is no longer lost. The pool
 * bypasses RLS, so `organization_id` comes from `requireRole` (session), never from
 * the body (anti-pattern 10). `admin` because it changes what the AI may state on the
 * organization's WhatsApp, the same bar as "Exigir de quem administra".
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import type { CamadaSemantica } from "@/lib/agent-engine/guardrails/camadas-da-org";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { NICHO_SAUDE, nichoSchema, type Nicho } from "@/lib/organizacoes/nicho";
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
    return fail("internal_error", err instanceof Error ? err.message : "save failed", 500, { requestId });
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
  if (saved.clinicalClaimLayerEnabled) {
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

  return ok(
    { nicho: parsed.data.nicho, clinical_claim_layer_enabled: saved.clinicalClaimLayerEnabled },
    { requestId },
  );
}

const CLINICAL_CLAIM_LAYER: CamadaSemantica = "afirmacao_clinica";

interface SavedNiche {
  previous: Nicho | null;
  /** True only when THIS call created the layer row (the org had never chosen). */
  clinicalClaimLayerEnabled: boolean;
}

/** `null` when the organization does not exist. */
async function saveNiche(pool: pg.Pool, organizationId: string, nicho: Nicho | null): Promise<SavedNiche | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // The lock is only for a consistent `previous` in the audit; the merge below would
    // not lose a concurrent key without it.
    const { rows } = await client.query<{ nicho: string | null }>(
      `select settings->>'nicho' as nicho from organizations where id = $1 for update`,
      [organizationId],
    );
    if (rows.length === 0) {
      await client.query("rollback");
      return null;
    }
    await client.query(
      `update organizations
          set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('nicho', $2::text)
        where id = $1`,
      [organizationId, nicho],
    );
    let clinicalClaimLayerEnabled = false;
    if (nicho === NICHO_SAUDE) {
      const inserted = await client.query(
        `insert into org_guardrail_layers (organization_id, layer, enabled)
         values ($1, $2, true)
         on conflict (organization_id, layer) do nothing`,
        [organizationId, CLINICAL_CLAIM_LAYER],
      );
      clinicalClaimLayerEnabled = inserted.rowCount === 1;
    }
    await client.query("commit");
    return { previous: nichoSchema.catch(null).parse(rows[0]?.nicho ?? null), clinicalClaimLayerEnabled };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
