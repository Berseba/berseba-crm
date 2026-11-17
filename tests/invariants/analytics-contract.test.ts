/**
 * Berseba (migration 9005): the analytics contract read by the platform's ops
 * collector — `analytics.v1_contagem_dia` and the login role `analytics_reader`.
 * Spec: Berseba/berseba#245.
 *
 * Three things are measured on the database the self-host kit installs
 * (`baseline.sql`), never on the text of the migration:
 *
 *  1. The counts. Only Berseba's organization, only leads tagged
 *     `plano-enterprise`, days in America/Sao_Paulo, touches deduplicated per
 *     (lead, day, channel) across `touch` activities and outbound WhatsApp.
 *  2. The reader. It reads the view and nothing else: no table, view or
 *     SECURITY DEFINER function in `public`. The API roles get nothing on
 *     `analytics`. Login, 2 connections, 15 s, and no password in the schema.
 *  3. The deploy. `fn_drop_views()` frees the columns the view pins (an
 *     upstream `alter column ... type` would fail otherwise) and
 *     `fn_recreate_views()` brings the view and its grant back.
 *
 * The baseline does not build the view (update.sh does, after it), so this
 * file calls `fn_recreate_views()` first, as update.sh would.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
});

const BERSEBA = "4212479e-2b5a-4949-807e-706b2fce16fe";
const OTHER = "a9a9a9a9-0000-4000-8000-000000000002";
const PIPELINE = "a9a9a9a9-1111-4000-8000-000000000001";
const STAGE = "a9a9a9a9-1111-4000-8000-000000000002";
const OTHER_PIPELINE = "a9a9a9a9-1111-4000-8000-000000000003";
const OTHER_STAGE = "a9a9a9a9-1111-4000-8000-000000000004";
const SESSION = "a9a9a9a9-2222-4000-8000-000000000001";
const OTHER_SESSION = "a9a9a9a9-2222-4000-8000-000000000002";
/** Tagged, created WITH the tag: no evidence, so created_at is its day. */
const LEAD_A = "a9a9a9a9-3333-4000-8000-00000000000a";
/** Tagged later: the event and the agent's lead_edited both name the tag; the earliest wins. */
const LEAD_B = "a9a9a9a9-3333-4000-8000-00000000000b";
/** Same organization, NOT tagged: nothing of it counts. */
const LEAD_C = "a9a9a9a9-3333-4000-8000-00000000000c";
/** Another organization, tagged: nothing of it counts. */
const LEAD_D = "a9a9a9a9-3333-4000-8000-00000000000d";
const CONTACT = (l: string) => l.replace("3333", "4444");
const CONVERSATION = (l: string) => l.replace("3333", "5555");

async function q(text: string, values: unknown[] = []) {
  return pool.query(text, values);
}

/** Runs one statement as analytics_reader, in its own transaction. */
async function asReader(text: string) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role analytics_reader");
    const result = await client.query(text);
    await client.query("rollback");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function activity(lead: string, org: string, type: string, at: string, payload: object = {}) {
  await q(
    `insert into public.crm_lead_activities
       (organization_id, lead_id, contact_id, type, source_module, actor_kind, reason, payload, performed_at)
     values ($1, $2, $3, $4, 'crm', 'system', 'invariant', $5::jsonb, $6)`,
    [org, lead, CONTACT(lead), type, JSON.stringify(payload), at],
  );
}

let externalId = 0;
async function message(lead: string, org: string, session: string, direction: string, status: string, at: string) {
  externalId += 1;
  await q(
    `insert into public.messages
       (organization_id, contact_id, conversation_id, channel_session_id, external_id, type, direction, status, created_at, sent_at)
     values ($1, $2, $3, $4, $5, 'text', $6, $7, $8, $8)`,
    [org, CONTACT(lead), CONVERSATION(lead), session, `analytics-${externalId}`, direction, status, at],
  );
}

beforeAll(async () => {
  await q("select analytics.fn_recreate_views()");

  for (const [org, slug] of [
    [BERSEBA, "berseba-analytics"],
    [OTHER, "other-analytics"],
  ] as const) {
    await q(
      `insert into public.organizations (id, slug, legal_name, display_name)
       values ($1, $2::text, $2::text, $2::text) on conflict do nothing`,
      [org, slug],
    );
  }
  await q(
    `insert into public.channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, 'analytics-b', 'WORKING', '\\x00'::bytea), ($3, $4, 'analytics-o', 'WORKING', '\\x00'::bytea)`,
    [SESSION, BERSEBA, OTHER_SESSION, OTHER],
  );
  await q(
    `insert into public.crm_pipelines (id, organization_id, name, slug)
     values ($1, $2, 'Comercial', 'comercial-analytics'), ($3, $4, 'Comercial', 'comercial-analytics')`,
    [PIPELINE, BERSEBA, OTHER_PIPELINE, OTHER],
  );
  await q(
    `insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
     values ($1, $2, $3, 'Novo', 'novo-analytics', 1000), ($4, $5, $6, 'Novo', 'novo-analytics', 1000)`,
    [STAGE, BERSEBA, PIPELINE, OTHER_STAGE, OTHER, OTHER_PIPELINE],
  );

  const leads: [string, string, string, string, string, string[], string][] = [
    [LEAD_A, BERSEBA, PIPELINE, STAGE, SESSION, ["plano-enterprise"], "2026-11-03T12:00:00Z"],
    [LEAD_B, BERSEBA, PIPELINE, STAGE, SESSION, ["plano-enterprise", "indicacao"], "2026-10-01T12:00:00Z"],
    [LEAD_C, BERSEBA, PIPELINE, STAGE, SESSION, ["plano-pro"], "2026-11-03T12:00:00Z"],
    [LEAD_D, OTHER, OTHER_PIPELINE, OTHER_STAGE, OTHER_SESSION, ["plano-enterprise"], "2026-11-03T12:00:00Z"],
  ];
  for (const [lead, org, pipeline, stage, session, tags, createdAt] of leads) {
    await q(`insert into public.contacts (id, organization_id, display_name) values ($1, $2, 'Contato analytics')`, [
      CONTACT(lead),
      org,
    ]);
    await q(
      `insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
       values ($1, $2, $3, $4, 'open')`,
      [CONVERSATION(lead), org, CONTACT(lead), session],
    );
    await q(
      `insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, tags, created_at)
       values ($1, $2, $3, $4, $5, 'Conta analytics', $6, $7)`,
      [lead, org, pipeline, stage, CONTACT(lead), tags, createdAt],
    );
  }

  // LEAD_B got the tag at 02:30 UTC on the 10th = 23:30 on the 9th in Brasília.
  await q(
    `insert into public.event_log (organization_id, event_type, entity_kind, entity_id, payload, created_at)
     values ($1, 'lead.tag_added', 'crm_lead', $2, '{"added_tags":["plano-enterprise"]}', '2026-11-10T02:30:00Z'),
            ($1, 'lead.tag_added', 'crm_lead', $2, '{"added_tags":["indicacao"]}', '2026-11-08T12:00:00Z')`,
    [BERSEBA, LEAD_B],
  );
  await activity(LEAD_B, BERSEBA, "lead_edited", "2026-11-11T12:00:00Z", { added_tags: ["plano-enterprise"] });

  // Touches on LEAD_A. The 4th: two e-mails (one touch) and a call (another).
  await activity(LEAD_A, BERSEBA, "touch", "2026-11-04T15:00:00Z", { channel: "email" });
  await activity(LEAD_A, BERSEBA, "touch", "2026-11-04T18:00:00Z", { channel: "email" });
  await activity(LEAD_A, BERSEBA, "touch", "2026-11-04T16:00:00Z", { channel: "call" });
  // The 5th: a WhatsApp touch AND an outbound WhatsApp message — one touch.
  await activity(LEAD_A, BERSEBA, "touch", "2026-11-05T13:00:00Z", { channel: "whatsapp" });
  await message(LEAD_A, BERSEBA, SESSION, "outbound", "sent", "2026-11-05T14:00:00Z");
  // The 6th: two outbound messages — one touch.
  await message(LEAD_A, BERSEBA, SESSION, "outbound", "read", "2026-11-06T13:00:00Z");
  await message(LEAD_A, BERSEBA, SESSION, "outbound", "delivered", "2026-11-06T13:05:00Z");
  // The 7th: a failed send and an inbound reply — no touch.
  await message(LEAD_A, BERSEBA, SESSION, "outbound", "failed", "2026-11-07T13:00:00Z");
  await message(LEAD_A, BERSEBA, SESSION, "inbound", "received", "2026-11-07T14:00:00Z");
  // A meeting on LEAD_B, the 6th.
  await activity(LEAD_B, BERSEBA, "appointment_scheduled", "2026-11-06T12:00:00Z");

  // Noise that must not count: the untagged lead and the other organization.
  for (const [lead, org, session] of [
    [LEAD_C, BERSEBA, SESSION],
    [LEAD_D, OTHER, OTHER_SESSION],
  ] as const) {
    await activity(lead, org, "touch", "2026-11-04T15:00:00Z", { channel: "linkedin" });
    await activity(lead, org, "appointment_scheduled", "2026-11-04T15:00:00Z");
    await message(lead, org, session, "outbound", "sent", "2026-11-08T13:00:00Z");
  }
});

afterAll(() => pool.end());

describe("analytics.v1_contagem_dia — the counts", () => {
  it("counts Berseba's plano-enterprise leads per Brasília day, and nothing else", async () => {
    const { rows } = await q(
      `select dia::text, contas_novas, toques, reunioes from analytics.v1_contagem_dia order by dia`,
    );
    expect(rows).toEqual([
      { dia: "2026-11-03", contas_novas: 1, toques: 0, reunioes: 0 },
      { dia: "2026-11-04", contas_novas: 0, toques: 2, reunioes: 0 },
      { dia: "2026-11-05", contas_novas: 0, toques: 1, reunioes: 0 },
      { dia: "2026-11-06", contas_novas: 0, toques: 1, reunioes: 1 },
      { dia: "2026-11-09", contas_novas: 1, toques: 0, reunioes: 0 },
    ]);
  });

  it("has exactly the contract's columns and types", async () => {
    const { rows } = await q(
      `select column_name, data_type from information_schema.columns
        where table_schema = 'analytics' and table_name = 'v1_contagem_dia' order by ordinal_position`,
    );
    expect(rows).toEqual([
      { column_name: "dia", data_type: "date" },
      { column_name: "contas_novas", data_type: "integer" },
      { column_name: "toques", data_type: "integer" },
      { column_name: "reunioes", data_type: "integer" },
    ]);
  });

  it("is a security barrier and carries its owner", async () => {
    const { rows } = await q(
      `select c.reloptions, obj_description(c.oid, 'pg_class') as comment
         from pg_class c where c.oid = 'analytics.v1_contagem_dia'::regclass`,
    );
    expect(rows[0].reloptions).toContain("security_barrier=true");
    expect(rows[0].comment).toMatch(/^Owner: Samuel \(comercial\)\./);
  });
});

describe("analytics_reader — reads the view and nothing else", () => {
  it("reads the view", async () => {
    const { rows } = await asReader("select count(*)::int as n from analytics.v1_contagem_dia");
    expect(rows[0].n).toBe(5);
  });

  it("cannot read public.crm_leads", async () => {
    await expect(asReader("select count(*) from public.crm_leads")).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot execute a public function", async () => {
    await expect(asReader("select public.fn_user_org_ids()")).rejects.toMatchObject({ code: "42501" });
  });

  it("no table, view or SECURITY DEFINER function in public is within its reach", async () => {
    const { rows } = await q(`
      select 'relation' as kind, c.oid::regclass::text as name
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p', 'f')
         and has_table_privilege('analytics_reader', c.oid, 'SELECT')
      union all
      select 'definer', p.oid::regprocedure::text
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef
         and has_function_privilege('analytics_reader', p.oid, 'EXECUTE')`);
    expect(rows).toEqual([]);
  });

  it("cannot run the rebuild functions", async () => {
    await expect(asReader("select analytics.fn_recreate_views()")).rejects.toMatchObject({ code: "42501" });
    await expect(asReader("select analytics.fn_drop_views()")).rejects.toMatchObject({ code: "42501" });
  });

  it("logs in with 2 connections and 15 s, and has no password in the schema", async () => {
    const { rows } = await q(
      `select r.rolcanlogin, r.rolconnlimit, r.rolsuper, r.rolbypassrls, r.rolcreaterole, a.rolpassword, r.rolconfig
         from pg_roles r join pg_authid a on a.oid = r.oid where r.rolname = 'analytics_reader'`,
    );
    expect(rows[0]).toMatchObject({
      rolcanlogin: true,
      rolconnlimit: 2,
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolpassword: null,
    });
    expect(rows[0].rolconfig).toContain("statement_timeout=15s");
  });

  it("the API roles get nothing on the analytics schema or the view", async () => {
    const { rows } = await q(`
      select r as role,
             has_schema_privilege(r, 'analytics', 'USAGE') as usage,
             has_table_privilege(r, 'analytics.v1_contagem_dia', 'SELECT') as select
        from unnest(array['anon', 'authenticated', 'service_role']) r`);
    for (const row of rows) expect(row).toMatchObject({ usage: false, select: false });
  });
});

describe("the deploy can rebuild the view around the baseline", () => {
  it("fn_drop_views frees the columns, and fn_recreate_views restores view and grant", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      // Control: while the view exists, changing a column it reads fails.
      await client.query("savepoint pinned");
      await expect(client.query("alter table public.crm_leads alter column tags type text[]")).rejects.toMatchObject({
        code: "0A000",
      });
      await client.query("rollback to savepoint pinned");

      await client.query("select analytics.fn_drop_views()");
      const { rows: left } = await client.query(
        `select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'analytics' and c.relkind = 'v'`,
      );
      expect(left[0].n).toBe(0);
      await client.query("alter table public.crm_leads alter column tags type text[]");

      await client.query("select analytics.fn_recreate_views()");
      await client.query("set local role analytics_reader");
      const { rows } = await client.query("select count(*)::int as n from analytics.v1_contagem_dia");
      expect(rows[0].n).toBe(5);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
