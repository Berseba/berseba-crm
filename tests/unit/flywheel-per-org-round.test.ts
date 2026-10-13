import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The scheduled flywheel runs one round per organization.
 *
 * Before: a single batch of the 10 most recent turns across all orgs, and any
 * error (one org out of budget, without a model, a provider 400, unparsable
 * output) aborted the whole run. Every org after the failing one in the batch was
 * never judged, run after run.
 *
 * This file pins the round's behavior with a fake pool. The SQL itself (per-org
 * quota, skip judged, latest turn per contact, lookback window) runs against real
 * Postgres in `tests/invariants/flywheel-per-org-isolation.test.ts`.
 */

const calls: Array<Record<string, unknown>> = [];
let failingOrg: string | null = null;

vi.mock("../../lib/agent-engine/edge/llm/run-model-call", () => ({
  runModelCall: vi.fn(async (_pool: unknown, _cfg: unknown, input: Record<string, unknown>) => {
    calls.push(input);
    if (input.tenantId === failingOrg) throw new Error("organization AI budget exhausted");
    return {
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
      result: {
        text:
          input.purpose === "flywheel_judge"
            ? '{"verdict":"no","missing_facts":["tipo de loja"]}'
            : '{"content":"Keep facts from other topics when consolidating.","scope":"agent"}',
      },
    };
  }),
}));

const TURNS = [
  { job_id: "00000002-0000-4000-8000-0000000000a1", organization_id: "org-a", contact_id: "contact-a1" },
  { job_id: "00000004-0000-4000-8000-0000000000a2", organization_id: "org-a", contact_id: "contact-a2" },
  { job_id: "00000006-0000-4000-8000-0000000000b1", organization_id: "org-b", contact_id: "contact-b1" },
];

function fakePool() {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const collectParams: unknown[][] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("from job_queue")) {
      collectParams.push(params);
      return { rows: TURNS, rowCount: TURNS.length };
    }
    if (sql.includes("insert into flywheel_")) {
      inserts.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as never, inserts, collectParams };
}

const LOG = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

beforeEach(() => {
  calls.length = 0;
  failingOrg = null;
});

describe("flywheel round per organization", () => {
  it("asks the collector for a quota per org, not a global batch", async () => {
    const { pool, collectParams } = fakePool();
    const { runFlywheelOnce } = await import("../../lib/agent-engine/flywheel/live");

    await runFlywheelOnce(pool, {} as never, { limit: 3, log: LOG });

    // [dataset, dimension, limitPerOrg, lookbackDays]
    expect(collectParams).toEqual([["live", "memory_hygiene", 3, 7]]);
  });

  it("charges every LLM call and writes every row to the turn's own org", async () => {
    const { pool, inserts } = fakePool();
    const { runFlywheelOnce } = await import("../../lib/agent-engine/flywheel/live");

    const result = await runFlywheelOnce(pool, {} as never, { limit: 10, log: LOG });

    // Positive control: all three turns went through judge + distiller.
    expect(calls).toHaveLength(6);
    for (const call of calls) {
      const turn = TURNS.find((t) => t.job_id === call.jobId);
      expect(turn, `LLM call for an unknown job ${String(call.jobId)}`).toBeDefined();
      expect(call.tenantId).toBe(turn!.organization_id);
      expect(call.leadId).toBe(turn!.contact_id);
    }
    expect(inserts).toHaveLength(6);
    for (const insert of inserts) {
      const jobId = insert.sql.includes("flywheel_judge_verdicts")
        ? insert.params[2]
        : (JSON.parse(String(insert.params[6])) as { trace_ids: string[] }).trace_ids[0];
      const turn = TURNS.find((t) => t.job_id === jobId);
      expect(insert.params[0]).toBe(turn!.organization_id);
    }
    expect(result).toMatchObject({ judged: 3, proposals: 3, failedOrgs: 0 });
  });

  it("an org that fails stops only its own round; the next org is still judged", async () => {
    failingOrg = "org-a";
    const { pool, inserts } = fakePool();
    const { runFlywheelOnce } = await import("../../lib/agent-engine/flywheel/live");

    const result = await runFlywheelOnce(pool, {} as never, { limit: 10, log: LOG });

    // org-a fails on its first call and stops; it does not keep paying for calls
    // that will fail the same way.
    expect(calls.filter((c) => c.tenantId === "org-a")).toHaveLength(1);
    expect(calls.filter((c) => c.tenantId === "org-b").map((c) => c.purpose)).toEqual([
      "flywheel_judge",
      "flywheel_distiller",
    ]);
    expect(inserts.every((i) => i.params[0] === "org-b")).toBe(true);
    expect(result).toMatchObject({ judged: 1, proposals: 1, failedOrgs: 1 });
  });
});
