import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FLYWHEEL ("Propostas") — ONE ROUND PER ORG, NEVER THE SAME TURN TWICE.
 *
 * The scheduled job used to take the 10 most recent finished turns across ALL
 * organizations, with no "already judged" filter:
 *   - a busy org filled the 10 slots every run and small orgs were never judged;
 *   - with no new turns, the same 10 were sent to the judge again every 6h. The
 *     `on conflict do nothing` on the verdict insert only dropped the row AFTER
 *     the judge call was paid.
 *
 * Real Postgres (baseline), LLM mocked: the collector's SQL, the unique index and
 * the org filters only exist in the database. The mocked LLM records every call
 * so the test can prove which org each call was charged to and what it was shown.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — run via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

afterAll(async () => {
  await pool.end();
});

type ModelCall = { tenantId: string; jobId: string; purpose: string; prompt: string };
const calls: ModelCall[] = [];

vi.mock("../../lib/agent-engine/edge/llm/run-model-call", () => ({
  runModelCall: vi.fn(
    async (
      _pool: unknown,
      _cfg: unknown,
      input: { tenantId: string; jobId: string; purpose: string; messages: Array<{ content: string }> },
    ) => {
      calls.push({
        tenantId: input.tenantId,
        jobId: input.jobId,
        purpose: input.purpose,
        prompt: input.messages.map((m) => m.content).join("\n"),
      });
      return {
        provider: "test",
        model: "test-model",
        result: {
          text:
            input.purpose === "flywheel_judge"
              ? '{"verdict":"no","missing_facts":["store type"]}'
              : '{"content":"Keep facts from other topics when consolidating.","scope":"org"}',
        },
      };
    },
  ),
}));

const LOG = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

let phoneSeq = 0;

async function createOrg(label: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $3)`,
    [id, `flywheel-${label}-${id}`, `Flywheel ${label}`],
  );
  return id;
}

/** A contact with one durable note carrying the org's marker, so the test can see
 *  which org's data ends up in which prompt. */
async function createContact(orgId: string, marker: string): Promise<string> {
  phoneSeq += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, name, phone_number) values ($1, 'Lead', $2) returning id`,
    [orgId, `+55119${String(phoneSeq).padStart(8, "0")}`],
  );
  const contactId = rows[0]!.id;
  await pool.query(
    `insert into lead_notes (organization_id, contact_id, headline, body) values ($1, $2, $3, $3)`,
    [orgId, contactId, marker],
  );
  return contactId;
}

/** A finished inbound turn, `ageMinutes` old, answered by the agent (or not). */
async function createTurn(
  orgId: string,
  contactId: string,
  ageMinutes: number,
  opts: { agentAnswered?: boolean } = {},
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into job_queue (organization_id, contact_id, kind, status, created_at)
     values ($1, $2, 'inbound_turn', 'done', now() - make_interval(mins => $3))
     returning id`,
    [orgId, contactId, ageMinutes],
  );
  const jobId = rows[0]!.id;
  if (opts.agentAnswered ?? true) {
    await pool.query(
      `insert into llm_calls (organization_id, contact_id, job_id, purpose, provider, model)
       values ($1, $2, $3, 'agent_turn', 'test', 'test-model')`,
      [orgId, contactId, jobId],
    );
  }
  return jobId;
}

async function rowsByOrg(table: "flywheel_judge_verdicts" | "flywheel_distiller_proposals", orgId: string) {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from ${table} where organization_id = $1`,
    [orgId],
  );
  return rows[0]!.n;
}

beforeEach(() => {
  calls.length = 0;
});

describe("flywheel collector", () => {
  it("gives each org its own quota: a busy org does not starve a small one", async () => {
    const { collectPendingTurns } = await import("../../lib/agent-engine/flywheel/live");
    const busy = await createOrg("busy");
    const small = await createOrg("small");
    for (let i = 0; i < 15; i += 1) {
      await createTurn(busy, await createContact(busy, "busy-fact"), i);
    }
    // The small org's only turn is OLDER than all 15 of the busy org's: under the
    // old global "10 most recent" it never made the cut.
    const smallTurn = await createTurn(small, await createContact(small, "small-fact"), 120);

    const turns = await collectPendingTurns(pool as never, 10);

    expect(turns.filter((t) => t.organization_id === busy)).toHaveLength(10);
    expect(turns.filter((t) => t.organization_id === small).map((t) => t.job_id)).toEqual([smallTurn]);
  });

  it("takes only the latest turn per contact, inside the lookback window, answered by the agent", async () => {
    const { collectPendingTurns } = await import("../../lib/agent-engine/flywheel/live");
    const orgId = await createOrg("shape");
    const chatty = await createContact(orgId, "shape-fact");
    await createTurn(orgId, chatty, 30);
    await createTurn(orgId, chatty, 20);
    const latest = await createTurn(orgId, chatty, 10);
    const stale = await createContact(orgId, "shape-fact");
    await createTurn(orgId, stale, 8 * 24 * 60);
    const unanswered = await createContact(orgId, "shape-fact");
    await createTurn(orgId, unanswered, 5, { agentAnswered: false });

    const turns = await collectPendingTurns(pool as never, 10);

    expect(turns.filter((t) => t.organization_id === orgId).map((t) => t.job_id)).toEqual([latest]);
  });

  it("skips a contact whose latest turn already has a verdict, without falling back to older turns", async () => {
    const { collectPendingTurns } = await import("../../lib/agent-engine/flywheel/live");
    const orgId = await createOrg("judged");
    const contactId = await createContact(orgId, "judged-fact");
    await createTurn(orgId, contactId, 30);
    const latest = await createTurn(orgId, contactId, 10);
    await pool.query(
      `insert into flywheel_judge_verdicts
         (organization_id, dataset, trace_id, dimension, verdict, option_order, judge_family, model, run_id)
       values ($1, 'live', $2, 'memory_hygiene', 'yes', 'yes_first', 'test', 'test-model', $3)`,
      [orgId, latest, randomUUID()],
    );

    const turns = await collectPendingTurns(pool as never, 10);

    expect(turns.filter((t) => t.organization_id === orgId)).toEqual([]);
  });
});

describe("flywheel run", () => {
  it("charges and writes to the turn's own org, shows it only that org's data, and never re-judges", async () => {
    const { runFlywheelOnce } = await import("../../lib/agent-engine/flywheel/live");
    const orgA = await createOrg("run-a");
    const orgB = await createOrg("run-b");
    const jobsA = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      jobsA.add(await createTurn(orgA, await createContact(orgA, "MARKER-ORG-A"), i));
    }
    const jobB = await createTurn(orgB, await createContact(orgB, "MARKER-ORG-B"), 60);

    const ours = (c: ModelCall) => c.tenantId === orgA || c.tenantId === orgB;

    // Run 1: 10 of A (quota) + the 1 of B.
    await runFlywheelOnce(pool as never, {} as never, { limitPerOrg: 10, log: LOG });
    const run1 = calls.filter(ours);
    expect(run1.filter((c) => c.purpose === "flywheel_judge" && c.tenantId === orgA)).toHaveLength(10);
    expect(run1.filter((c) => c.purpose === "flywheel_judge" && c.tenantId === orgB)).toHaveLength(1);
    for (const call of run1) {
      // Charged to the org that owns the turn.
      expect(call.tenantId === orgB ? call.jobId === jobB : jobsA.has(call.jobId)).toBe(true);
      if (call.purpose !== "flywheel_judge") continue;
      // The judge saw only its own org's notes.
      const own = call.tenantId === orgA ? "MARKER-ORG-A" : "MARKER-ORG-B";
      const other = call.tenantId === orgA ? "MARKER-ORG-B" : "MARKER-ORG-A";
      expect(call.prompt).toContain(own);
      expect(call.prompt).not.toContain(other);
    }
    expect(await rowsByOrg("flywheel_judge_verdicts", orgA)).toBe(10);
    expect(await rowsByOrg("flywheel_judge_verdicts", orgB)).toBe(1);
    expect(await rowsByOrg("flywheel_distiller_proposals", orgA)).toBe(10);
    expect(await rowsByOrg("flywheel_distiller_proposals", orgB)).toBe(1);
    // No verdict row points at a turn of another org.
    const { rows: crossed } = await pool.query<{ n: number }>(
      `select count(*)::int as n
       from flywheel_judge_verdicts v
       join job_queue j on j.id::text = v.trace_id
       where v.organization_id in ($1, $2) and j.organization_id <> v.organization_id`,
      [orgA, orgB],
    );
    expect(crossed[0]!.n).toBe(0);

    // Run 2: only the 2 of A left over by the quota.
    calls.length = 0;
    await runFlywheelOnce(pool as never, {} as never, { limitPerOrg: 10, log: LOG });
    const run2Judge = calls.filter((c) => ours(c) && c.purpose === "flywheel_judge");
    expect(run2Judge.map((c) => c.tenantId)).toEqual([orgA, orgA]);

    // Run 3: nothing new, nothing paid.
    calls.length = 0;
    await runFlywheelOnce(pool as never, {} as never, { limitPerOrg: 10, log: LOG });
    expect(calls.filter(ours)).toEqual([]);
    expect(await rowsByOrg("flywheel_judge_verdicts", orgA)).toBe(12);
  });
});
