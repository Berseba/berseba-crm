import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Invariantes de `crm_stage_move_suggestions` (migration 0239, "sugestão de
 * etapa" — a IA sugere, o humano confirma):
 *
 *  1. isolamento RLS entre 2 organizações (a mesma prova de sempre: usuário de
 *     A não vê linha de B, via `fn_user_org_ids()`);
 *  2. o índice único parcial `(lead_id) where status = 'pending'` — uma
 *     sugestão pendente por negócio, no banco, não só no código.
 *
 * Mesmo padrão de conexão de `autonomia-authority.test.ts`: `pg.Pool` direto
 * contra o Postgres efêmero que `scripts/test-db.sh` sobe com `baseline.sql`
 * já aplicado.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 6,
});

afterAll(() => pool.end());

async function seedOrg(tag: string) {
  const org = randomUUID();
  const user = randomUUID();
  const pipeline = randomUUID();
  const stageAtiva = randomUUID();
  const stageGanha = randomUUID();
  const lead = randomUUID();

  await pool.query(
    "insert into auth.users(id, email) values ($1, $2) on conflict do nothing",
    [user, `sugestao-etapa-${tag}@invariant.test`],
  );
  await pool.query(
    "insert into organizations(id, slug, legal_name, display_name) values ($1, $1::text, $2, $2)",
    [org, `Sugestão de Etapa ${tag}`],
  );
  await pool.query(
    "insert into user_organizations(organization_id, user_id, role, accepted_at) values ($1, $2, 'agent', now())",
    [org, user],
  );
  await pool.query(
    "insert into crm_pipelines(id, organization_id, name, slug) values ($1, $2, 'Pipeline', $3)",
    [pipeline, org, `pipe-${tag}`],
  );
  await pool.query(
    "insert into crm_stages(id, organization_id, pipeline_id, name, slug, position, is_won) values ($1, $2, $3, 'Ativa', $4, 1000, false)",
    [stageAtiva, org, pipeline, `ativa-${tag}`],
  );
  await pool.query(
    "insert into crm_stages(id, organization_id, pipeline_id, name, slug, position, is_won) values ($1, $2, $3, 'Ganha', $4, 2000, true)",
    [stageGanha, org, pipeline, `ganha-${tag}`],
  );
  await pool.query(
    "insert into crm_leads(id, organization_id, pipeline_id, stage_id, title) values ($1, $2, $3, $4, 'Negócio de teste')",
    [lead, org, pipeline, stageAtiva],
  );

  return { org, user, pipeline, stageAtiva, stageGanha, lead };
}

async function insertSugestao(
  args: { org: string; lead: string; from: string; to: string; status?: string },
) {
  return pool.query(
    `insert into crm_stage_move_suggestions
       (organization_id, lead_id, from_stage_id, to_stage_id, source, status)
     values ($1, $2, $3, $4, 'agent_turn', coalesce($5, 'pending'))
     returning id`,
    [args.org, args.lead, args.from, args.to, args.status ?? null],
  );
}

let a: Awaited<ReturnType<typeof seedOrg>>;
let b: Awaited<ReturnType<typeof seedOrg>>;

beforeAll(async () => {
  a = await seedOrg("a");
  b = await seedOrg("b");
});

describe("crm_stage_move_suggestions — isolamento RLS entre organizações", () => {
  it("usuário de A não vê a sugestão de B (fn_user_org_ids)", async () => {
    await insertSugestao({ org: a.org, lead: a.lead, from: a.stageAtiva, to: a.stageGanha });
    await insertSugestao({ org: b.org, lead: b.lead, from: b.stageAtiva, to: b.stageGanha });

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: a.user, role: "authenticated" }),
      ]);
      const { rows } = await client.query(
        "select organization_id from crm_stage_move_suggestions",
      );
      const orgs = new Set(rows.map((r: { organization_id: string }) => r.organization_id));
      expect(orgs.has(a.org)).toBe(true);
      expect(orgs.has(b.org)).toBe(false);
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
  });
});

describe("crm_stage_move_suggestions — índice único parcial (uma pendente por negócio)", () => {
  it("uma segunda sugestão PENDENTE para o mesmo lead é rejeitada pelo banco", async () => {
    const lead = randomUUID();
    await pool.query(
      "insert into crm_leads(id, organization_id, pipeline_id, stage_id, title) values ($1, $2, $3, $4, 'Lead do índice')",
      [lead, a.org, a.pipeline, a.stageAtiva],
    );

    await insertSugestao({ org: a.org, lead, from: a.stageAtiva, to: a.stageGanha });

    await expect(
      insertSugestao({ org: a.org, lead, from: a.stageAtiva, to: a.stageGanha }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("depois de marcar a anterior 'stale', a nova PENDENTE é aceita — a garantia é POR STATUS, não por lead", async () => {
    const lead = randomUUID();
    await pool.query(
      "insert into crm_leads(id, organization_id, pipeline_id, stage_id, title) values ($1, $2, $3, $4, 'Lead do índice 2')",
      [lead, a.org, a.pipeline, a.stageAtiva],
    );

    await insertSugestao({ org: a.org, lead, from: a.stageAtiva, to: a.stageGanha });
    await pool.query(
      "update crm_stage_move_suggestions set status = 'stale' where organization_id = $1 and lead_id = $2 and status = 'pending'",
      [a.org, lead],
    );

    await expect(
      insertSugestao({ org: a.org, lead, from: a.stageAtiva, to: a.stageGanha }),
    ).resolves.toBeDefined();

    const { rows } = await pool.query(
      "select status from crm_stage_move_suggestions where organization_id = $1 and lead_id = $2 order by created_at",
      [a.org, lead],
    );
    expect(rows.map((r: { status: string }) => r.status)).toEqual(["stale", "pending"]);
  });
});
