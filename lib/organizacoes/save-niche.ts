/**
 * Berseba: the write behind `PATCH /api/v1/settings/nicho` (BERSEBA.md, "Organization niche").
 *
 * One transaction on a raw pool, which bypasses RLS: the caller passes an
 * `organizationId` resolved from the session, never from the body (anti-pattern 10).
 * Kept out of the route so `tests/invariants/save-niche.test.ts` can run it against the
 * baseline in a real Postgres.
 *
 * What it guarantees, and what it does not (issue #37):
 *  - the key is merged by the UPDATE itself (`settings || jsonb_build_object`), so saving
 *    the niche never drops another key of `organizations.settings`;
 *  - it does NOT protect the niche from the other writers of `settings`, which still read,
 *    spread and write the whole object (MFA policy, routing, sounds…). The `for update`
 *    below only makes `previous` consistent for the audit — a writer that never takes the
 *    lock is not stopped by it.
 *
 * `saude` also switches upstream's `afirmacao_clinica` layer on when the organization never
 * chose it (issue #35). An explicit choice is never overwritten, so the call reports the
 * layer's state after the write and the screen can warn when it is off by choice.
 */
import type pg from "pg";

import type { CamadaSemantica } from "@/lib/agent-engine/guardrails/camadas-da-org";
import { NICHO_SAUDE, nichoSchema, type Nicho } from "@/lib/organizacoes/nicho";

export const CLINICAL_CLAIM_LAYER: CamadaSemantica = "afirmacao_clinica";

/**
 * The clinical-claim layer after a save to `saude`:
 *  - `enabled_now`: this call switched it on (the organization had never chosen);
 *  - `already_on`: it was already on;
 *  - `off_by_choice`: someone switched it off in the agent's security panel, and it stays off.
 * `null` when the niche saved is not `saude` (the layer was not touched).
 */
export type ClinicalClaimLayerState = "enabled_now" | "already_on" | "off_by_choice";

export interface SavedNiche {
  previous: Nicho | null;
  clinicalClaimLayer: ClinicalClaimLayerState | null;
}

/** `null` when the organization does not exist (nothing is written). */
export async function saveNiche(
  pool: pg.Pool,
  organizationId: string,
  nicho: Nicho | null,
): Promise<SavedNiche | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
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
    let clinicalClaimLayer: ClinicalClaimLayerState | null = null;
    if (nicho === NICHO_SAUDE) {
      const inserted = await client.query(
        `insert into org_guardrail_layers (organization_id, layer, enabled)
         values ($1, $2, true)
         on conflict (organization_id, layer) do nothing`,
        [organizationId, CLINICAL_CLAIM_LAYER],
      );
      if (inserted.rowCount === 1) {
        clinicalClaimLayer = "enabled_now";
      } else {
        const { rows: layer } = await client.query<{ enabled: boolean }>(
          `select enabled from org_guardrail_layers where organization_id = $1 and layer = $2`,
          [organizationId, CLINICAL_CLAIM_LAYER],
        );
        clinicalClaimLayer = layer[0]?.enabled === true ? "already_on" : "off_by_choice";
      }
    }
    await client.query("commit");
    return { previous: nichoSchema.catch(null).parse(rows[0]?.nicho ?? null), clinicalClaimLayer };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
