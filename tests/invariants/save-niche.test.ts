import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { saveNiche } from "@/lib/organizacoes/save-niche";

/**
 * Berseba: the niche write (`lib/organizacoes/save-niche.ts`, issues #35/#37) against the
 * baseline in a real Postgres. The route test mocks the pool and only proves what SQL is
 * SENT; this proves what Postgres DOES with it: empty `settings`, another key kept, the
 * layer's primary key in `on conflict`, an explicit `enabled = false` never overwritten, and
 * a concurrent writer that holds the row lock losing nothing.
 */

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

const ORG = "0b5eaaaa-0000-4000-8000-000000000001";

async function settings(): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query<{ settings: Record<string, unknown> | null }>(
    `select settings from organizations where id = $1`,
    [ORG],
  );
  return rows[0]?.settings ?? null;
}

async function layer(): Promise<boolean | null> {
  const { rows } = await pool.query<{ enabled: boolean }>(
    `select enabled from org_guardrail_layers where organization_id = $1 and layer = 'afirmacao_clinica'`,
    [ORG],
  );
  return rows[0]?.enabled ?? null;
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-save-niche', 'Org save niche', 'Org save niche') on conflict (id) do nothing`,
    [ORG],
  );
});

beforeEach(async () => {
  await pool.query(`delete from org_guardrail_layers where organization_id = $1`, [ORG]);
  await pool.query(`update organizations set settings = '{}'::jsonb where id = $1`, [ORG]);
});

afterAll(async () => {
  await pool.query(`delete from organizations where id = $1`, [ORG]);
  await pool.end();
});

describe("saveNiche — against the baseline", () => {
  it("empty settings: the key is created (settings is NOT NULL in the baseline)", async () => {
    const saved = await saveNiche(pool, ORG, "ecommerce");
    expect(saved).toEqual({ previous: null, clinicalClaimLayer: null });
    expect(await settings()).toEqual({ nicho: "ecommerce" });
  });

  it("another key of settings survives, and null clears the niche", async () => {
    await pool.query(`update organizations set settings = '{"security":{"mfa_required":true}}' where id = $1`, [
      ORG,
    ]);
    await saveNiche(pool, ORG, "saude");
    const saved = await saveNiche(pool, ORG, null);
    expect(saved?.previous).toBe("saude");
    expect(await settings()).toEqual({ security: { mfa_required: true }, nicho: null });
  });

  it("saude with no choice switches the layer on (enabled_now), then reports already_on", async () => {
    expect((await saveNiche(pool, ORG, "saude"))?.clinicalClaimLayer).toBe("enabled_now");
    expect(await layer()).toBe(true);
    expect((await saveNiche(pool, ORG, "saude"))?.clinicalClaimLayer).toBe("already_on");
  });

  it("saude never overwrites a layer switched off by choice (off_by_choice)", async () => {
    await pool.query(
      `insert into org_guardrail_layers (organization_id, layer, enabled) values ($1, 'afirmacao_clinica', false)`,
      [ORG],
    );
    expect((await saveNiche(pool, ORG, "saude"))?.clinicalClaimLayer).toBe("off_by_choice");
    expect(await layer()).toBe(false);
  });

  it("leaving saude leaves the layer as it is", async () => {
    await saveNiche(pool, ORG, "saude");
    await saveNiche(pool, ORG, null);
    expect(await layer()).toBe(true);
  });

  it("unknown organization: null, nothing written", async () => {
    expect(await saveNiche(pool, "0b5eaaaa-0000-4000-8000-0000000000ff", "saude")).toBeNull();
  });

  it("a concurrent writer that holds the row lock loses nothing, and neither does the niche", async () => {
    const other = await pool.connect();
    try {
      await other.query("begin");
      await other.query(`select 1 from organizations where id = $1 for update`, [ORG]);
      await other.query(
        `update organizations set settings = coalesce(settings, '{}'::jsonb) || '{"sounds":{"on":true}}' where id = $1`,
        [ORG],
      );
      const pending = saveNiche(pool, ORG, "saude"); // blocks on the row lock
      await new Promise((r) => setTimeout(r, 200));
      await other.query("commit");
      expect((await pending)?.clinicalClaimLayer).toBe("enabled_now");
    } finally {
      other.release();
    }
    expect(await settings()).toEqual({ sounds: { on: true }, nicho: "saude" });
  });
});
