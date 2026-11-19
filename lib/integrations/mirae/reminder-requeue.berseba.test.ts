// @vitest-environment node
/**
 * Berseba: a Mirae reminder discarded for a stale service boundary is queued again on the
 * conversation's current boundary, bounded, and never lost in silence.
 */
import { describe, expect, it, vi } from "vitest";

import { MAX_REQUEUES, requeueStaleMiraeReminder } from "./reminder-requeue";

const NOW = new Date("2026-11-17T12:00:00.000Z");
const REMINDER = {
  delivery_key: "rem-1:k",
  reminder_id: "rem-1",
  delivery: "auto",
  kind: "evaluation_confirmation",
  title: "Confirmar avaliação",
  note: null,
  student_name: "Ana",
  appointment_start_at: "2026-11-18T12:00:00.000Z",
  professional_first_name: "Raquel",
  mirae_phone: "14996598955",
};
const JOB = {
  id: "job-1",
  organization_id: "org",
  contact_id: "contact",
  payload: {
    source: "mirae_reminder",
    reason: "Lembrete do Mirae: Confirmar avaliação",
    promised_at: "2026-11-17T11:00:00.000Z",
    mirae_reminder: REMINDER,
    conversation_id: "conv",
    service_boundary: { conversation_id: "conv", service_revision: 1 },
  } as Record<string, unknown>,
};
const BOUNDARY = {
  organization_id: "org",
  contact_id: "contact",
  conversation_id: "conv",
  service_revision: 2,
  demanda_id: null,
  demanda_revision: null,
  status: "open",
};

function fakePool(over: { done?: boolean; live?: boolean } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes("requeued_from")) return { rows: over.done ? [{}] : [] };
    if (sql.includes("as live")) return { rows: [{ live: over.live === true }] };
    if (sql.includes("from conversations")) return { rows: [{ channel_session_id: "channel" }] };
    if (sql.includes("fn_service_begin")) return { rows: [{ b: BOUNDARY }] };
    return { rows: [] };
  });
  const client = { query, release: vi.fn() };
  return { pool: { connect: vi.fn(async () => client) } as never, calls, client };
}

describe("requeueStaleMiraeReminder", () => {
  it("queues the same reminder again, due now, on the current boundary", async () => {
    const { pool, calls } = fakePool();
    const avisar = vi.fn();
    expect(await requeueStaleMiraeReminder(pool, JOB as never, NOW, avisar)).toBe("requeued");
    expect(calls.find((c) => c.sql.includes("fn_service_begin"))!.params).toEqual(["org", "contact", "channel"]);
    const insert = calls.find((c) => c.sql.includes("insert into cron_jobs"))!;
    expect(insert.params[0]).toBe("org");
    expect(insert.params[3]).toEqual(NOW);
    expect(insert.params[2]).toMatchObject({
      source: "mirae_reminder",
      mirae_reminder: REMINDER,
      requeued_from: "job-1",
      mirae_requeues: 1,
      service_boundary: { conversation_id: "conv", service_revision: 2 },
    });
    expect(insert.params[2]).not.toHaveProperty("service_boundary.status");
    expect(avisar).not.toHaveBeenCalled();
  });

  it("takes the contact lock and checks for another return before queuing, in one transaction", async () => {
    const { pool, calls, client } = fakePool();
    await requeueStaleMiraeReminder(pool, JOB as never, NOW, vi.fn());
    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toBe("begin");
    expect(sqls.at(-1)).toBe("commit");
    const iLock = calls.findIndex((c) => c.params[0] === "mirae_reminder_contact:org:contact");
    const iLive = sqls.findIndex((q) => q.includes("as live"));
    const iInsert = sqls.findIndex((q) => q.includes("insert into cron_jobs"));
    expect(iLock).toBeGreaterThan(0);
    expect(iLive).toBeGreaterThan(iLock);
    expect(iInsert).toBeGreaterThan(iLive);
    // The horizon is the appointment.
    expect(calls[iLive]!.params).toEqual(["org", "contact", new Date("2026-11-18T12:00:00.000Z"), "charge_notice"]);
    expect(client.release).toHaveBeenCalled();
  });

  it("another return due before the appointment: not queued again, the team is told", async () => {
    const { pool, calls } = fakePool({ live: true });
    const avisar = vi.fn();
    expect(await requeueStaleMiraeReminder(pool, JOB as never, NOW, avisar)).toBe("already_handled");
    expect(calls.some((c) => c.sql.includes("insert"))).toBe(false);
    expect(avisar).toHaveBeenCalledTimes(1);
  });

  it("is idempotent per discarded job", async () => {
    const { pool, calls } = fakePool({ done: true });
    expect(await requeueStaleMiraeReminder(pool, JOB as never, NOW, vi.fn())).toBe("already_requeued");
    expect(calls.some((c) => c.sql.includes("insert"))).toBe(false);
  });

  it("too late, or requeued too many times: the team is told, nothing queued", async () => {
    for (const [job, now, outcome] of [
      [JOB, new Date("2026-11-18T11:30:00.000Z"), "too_late"],
      [{ ...JOB, payload: { ...JOB.payload, mirae_requeues: MAX_REQUEUES } }, NOW, "exhausted"],
    ] as const) {
      const { pool, calls } = fakePool();
      const avisar = vi.fn();
      expect(await requeueStaleMiraeReminder(pool, job as never, now, avisar)).toBe(outcome);
      expect(avisar).toHaveBeenCalledTimes(1);
      expect(calls.some((c) => c.sql.includes("insert"))).toBe(false);
    }
  });

  it("any other return is not touched", async () => {
    const { pool, calls } = fakePool();
    expect(
      await requeueStaleMiraeReminder(pool, { ...JOB, payload: { reason: "x" } } as never, NOW, vi.fn()),
    ).toBe("not_mirae");
    expect(calls).toEqual([]);
  });
});

describe("wiring (source contract)", () => {
  it("the worker hands a stale followup turn to the requeue after discarding it", async () => {
    const { readFileSync } = await import("node:fs");
    const fonte = readFileSync("workers/agent-worker/dispor-job-apos-falha.ts", "utf8");
    const iDescarte = fonte.indexOf("await descartarFollowupObsoleto(pool, job, workerId, log);");
    const iRequeue = fonte.indexOf("await requeueStaleMiraeReminder(pool, job, new Date())");
    expect(iDescarte).toBeGreaterThan(-1);
    expect(iRequeue).toBeGreaterThan(iDescarte);
  });
});
