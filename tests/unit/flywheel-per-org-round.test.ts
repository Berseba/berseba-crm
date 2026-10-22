import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The scheduled flywheel runs one round per organization.
 *
 * Before: a single batch of the 10 most recent turns across all orgs, and any
 * error (one org out of budget, without a model, a provider 400, unparsable
 * output) aborted the whole run. Every org after the failing one in the batch was
 * never judged, run after run.
 *
 * Two kinds of failure, two scopes: a THROWN model call stops that org's round
 * (its turns are retried next run); an unusable ANSWER is recorded on that turn
 * as `unknown` and the round goes on, so the turn is never paid for twice.
 *
 * This file pins the round's behavior with a fake pool. The SQL itself (per-org
 * quota, skip judged, latest turn per contact, lookback window) runs against real
 * Postgres in `tests/invariants/flywheel-per-org-isolation.test.ts`.
 */

const calls: Array<Record<string, unknown>> = [];
let failingOrg: string | null = null;
/** job_id → raw judge/distiller text, to simulate prose-wrapped or invalid answers. */
const judgeTextByJob = new Map<string, string>();
const distillerTextByJob = new Map<string, string>();

vi.mock("../../lib/agent-engine/edge/llm/run-model-call", () => ({
  runModelCall: vi.fn(async (_pool: unknown, _cfg: unknown, input: Record<string, unknown>) => {
    calls.push(input);
    if (input.tenantId === failingOrg) throw new Error("organization AI budget exhausted");
    const jobId = String(input.jobId);
    return {
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
      result: {
        text:
          input.purpose === "flywheel_judge"
            ? (judgeTextByJob.get(jobId) ?? '{"verdict":"no","missing_facts":["tipo de loja"]}')
            : (distillerTextByJob.get(jobId) ??
              '{"content":"Keep facts from other topics when consolidating.","scope":"agent"}'),
      },
    };
  }),
}));

const TURNS = [
  { job_id: "00000002-0000-4000-8000-0000000000a1", organization_id: "org-a", contact_id: "contact-a1" },
  { job_id: "00000004-0000-4000-8000-0000000000a2", organization_id: "org-a", contact_id: "contact-a2" },
  { job_id: "00000006-0000-4000-8000-0000000000b1", organization_id: "org-b", contact_id: "contact-b1" },
];

function fakePool(opts: { lockHeldElsewhere?: boolean } = {}) {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const collectParams: unknown[][] = [];
  const lockEvents: string[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("pg_try_advisory_lock")) {
      lockEvents.push("lock");
      return { rows: [{ locked: !opts.lockHeldElsewhere }], rowCount: 1 };
    }
    if (sql.includes("pg_advisory_unlock")) {
      lockEvents.push("unlock");
      return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
    }
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
  const connect = vi.fn(async () => ({ query, release: () => lockEvents.push("release") }));
  return { pool: { query, connect } as never, inserts, collectParams, lockEvents };
}

const LOG = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

beforeEach(() => {
  calls.length = 0;
  failingOrg = null;
  judgeTextByJob.clear();
  distillerTextByJob.clear();
});

function verdictInserts(inserts: Array<{ sql: string; params: unknown[] }>) {
  return inserts
    .filter((i) => i.sql.includes("flywheel_judge_verdicts"))
    .map((i) => ({
      org: i.params[0],
      jobId: i.params[2],
      verdict: i.params[4],
      provenance: JSON.parse(String(i.params[8])) as Record<string, unknown>,
    }));
}

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

  it("a prose answer on one turn is recorded as unknown and the org's round goes on", async () => {
    judgeTextByJob.set(TURNS[0]!.job_id, "Sure! After reading the conversation, the agent did fine overall.");
    const { pool, inserts } = fakePool();
    const { runFlywheelOnce } = await import("../../lib/agent-engine/flywheel/live");

    const result = await runFlywheelOnce(pool, {} as never, { limit: 10, log: LOG });

    const verdicts = verdictInserts(inserts);
    // The bad turn has a row, so the collector never picks it (or pays for it) again.
    expect(verdicts.find((v) => v.jobId === TURNS[0]!.job_id)).toMatchObject({
      org: "org-a",
      verdict: "unknown",
      provenance: { error: "unparsable" },
    });
    // The turn ranked after it in the same org was still judged, and nothing failed.
    expect(verdicts.find((v) => v.jobId === TURNS[1]!.job_id)).toMatchObject({ verdict: "no" });
    expect(verdicts.find((v) => v.jobId === TURNS[1]!.job_id)?.provenance.error).toBeUndefined();
    // No distiller call for the unknown turn.
    expect(calls.filter((c) => c.jobId === TURNS[0]!.job_id).map((c) => c.purpose)).toEqual(["flywheel_judge"]);
    expect(result).toMatchObject({ judged: 3, proposals: 2, failedOrgs: 0, skipped: false });
  });

  it("a verdict outside the vocabulary is recorded as unknown with its own error", async () => {
    judgeTextByJob.set(TURNS[2]!.job_id, '{"verdict":"maybe","missing_facts":[]}');
    const { pool, inserts } = fakePool();
    const { runFlywheelOnce } = await import("../../lib/agent-engine/flywheel/live");

    await runFlywheelOnce(pool, {} as never, { limit: 10, log: LOG });

    expect(verdictInserts(inserts).find((v) => v.jobId === TURNS[2]!.job_id)).toMatchObject({
      verdict: "unknown",
      provenance: { error: "invalid_verdict" },
    });
  });

  it("an unusable distiller answer drops that proposal only; the round goes on", async () => {
    distillerTextByJob.set(TURNS[0]!.job_id, "Here is my suggestion: be careful with notes.");
    const { pool, inserts } = fakePool();
    const { runFlywheelOnce } = await import("../../lib/agent-engine/flywheel/live");

    const result = await runFlywheelOnce(pool, {} as never, { limit: 10, log: LOG });

    const proposals = inserts.filter((i) => i.sql.includes("flywheel_distiller_proposals"));
    expect(proposals).toHaveLength(2);
    expect(result).toMatchObject({ judged: 3, proposals: 2, failedOrgs: 0 });
  });

  it("skips the whole run, paying nothing, when another run holds the lock", async () => {
    const { pool, inserts, collectParams, lockEvents } = fakePool({ lockHeldElsewhere: true });
    const { runFlywheelOnce } = await import("../../lib/agent-engine/flywheel/live");

    const result = await runFlywheelOnce(pool, {} as never, { limit: 10, log: LOG });

    expect(result).toMatchObject({ skipped: true, judged: 0, proposals: 0 });
    expect(calls).toEqual([]);
    expect(collectParams).toEqual([]);
    expect(inserts).toEqual([]);
    // It never took the lock, so it must not release someone else's; the client goes back.
    expect(lockEvents).toEqual(["lock", "release"]);
  });

  it("releases the lock and the client after a run", async () => {
    const { pool, lockEvents } = fakePool();
    const { runFlywheelOnce } = await import("../../lib/agent-engine/flywheel/live");

    await runFlywheelOnce(pool, {} as never, { limit: 10, log: LOG });

    expect(lockEvents).toEqual(["lock", "unlock", "release"]);
  });
});
