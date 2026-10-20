/**
 * Berseba: the 90-day cleanup of ad clicks that never became a conversation.
 *
 * The admin client is an in-memory PostgREST that APPLIES the filters, so
 * "matched rows are never deleted" is measured on the rows left behind and not
 * only on the calls made. The calls are recorded too, to pin the filters.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  audit: vi.fn(),
  logError: vi.fn(),
  admin: null as unknown,
  rpcCalls: [] as string[],
  cascade: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({ audit: mock.audit }));
vi.mock("@/lib/logger", () => ({
  logger: { error: mock.logError, warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/env", () => ({
  env: {
    INTERNAL_CRON_SECRET: "segredo",
    INTERNAL_SECRET: "",
    JOB_QUEUE_RETENTION_DAYS: "",
    AUDIT_LOG_RETENTION_DAYS: "",
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (mock.admin === null) throw new Error("service role key missing");
    return mock.admin;
  },
}));
vi.mock("@/lib/lgpd/cascata", () => ({ varrerRedacoesIncompletas: mock.cascade }));

import { GET } from "@/app/api/v1/cron/data-retention/route";
import {
  CLICK_REF_TABLES,
  CLICK_RETENTION_BATCH_SIZE,
  CLICK_RETENTION_MAX_BATCHES,
  UNMATCHED_CLICK_RETENTION_DAYS,
  deleteUnmatchedClicks,
  runUnmatchedClickRetention,
} from "@/lib/plataformas-de-anuncio/click-ref-retention";

const GOOGLE = "google_ads_click_refs";
const META = "meta_ads_click_refs";
const DAY = 86_400_000;
const NOW = new Date("2026-10-20T12:00:00.000Z");
const CUTOFF = "2026-07-22T12:00:00.000Z"; // 90 days before NOW

interface Row {
  id: string;
  created_at: string;
  matched_at: string | null;
  /** Absent means null: only the tracked-link path sets it. */
  tracking_link_id?: string | null;
}
interface Call {
  table: string;
  op: "select" | "delete";
  is: [string, unknown][];
  lt: [string, string][];
  in: [string, string[]][];
  order: string | null;
  limit: number | null;
}
interface Hooks {
  failSelect?: Record<string, string>;
  failDelete?: Record<string, string>;
  /** The 1-based delete call (any table) that fails. */
  failNthDelete?: number;
  beforeDelete?: (table: string, ids: string[]) => void;
}

const daysAgo = (days: number, extraMs = 0) =>
  new Date(NOW.getTime() - days * DAY - extraMs).toISOString();

function oldUnmatched(table: string, count: number, prefix = "old"): Row[] {
  // Oldest first by index, all well past the cutoff.
  return Array.from({ length: count }, (_, i) => ({
    id: `${table}-${prefix}-${i}`,
    created_at: daysAgo(120, (count - i) * 1000),
    matched_at: null,
  }));
}

function fakeAdmin(initial: Record<string, Row[]>, hooks: Hooks = {}) {
  const tables = initial;
  const calls: Call[] = [];
  let deletes = 0;

  const client = {
    from(table: string) {
      const call: Call = { table, op: "select", is: [], lt: [], in: [], order: null, limit: null };
      const run = () => {
        calls.push(call);
        const rows = tables[table] ?? [];
        const read = (row: Row, column: string) =>
          (row as unknown as Record<string, unknown>)[column] ?? null;
        const matching = () =>
          rows.filter(
            (row) =>
              call.is.every(([column, value]) => read(row, column) === value) &&
              call.lt.every(([column, value]) => String(read(row, column)) < value) &&
              call.in.every(([column, values]) => values.includes(String(read(row, column)))),
          );

        if (call.op === "select") {
          const failure = hooks.failSelect?.[table];
          if (failure) return { data: null, error: { message: failure } };
          let found = matching();
          if (call.order)
            found = [...found].sort((a, b) => a.created_at.localeCompare(b.created_at));
          if (call.limit !== null) found = found.slice(0, call.limit);
          return { data: found.map((row) => ({ id: row.id })), error: null };
        }

        deletes += 1;
        const failure = hooks.failDelete?.[table];
        if (failure || hooks.failNthDelete === deletes) {
          return { data: null, error: { message: failure ?? "delete failed" } };
        }
        hooks.beforeDelete?.(table, call.in[0]?.[1] ?? []);
        const found = matching();
        tables[table] = rows.filter((row) => !found.includes(row));
        return { data: found.map((row) => ({ id: row.id })), error: null };
      };

      const builder: Record<string, unknown> = {
        select: () => builder,
        delete: () => {
          call.op = "delete";
          return builder;
        },
        is: (column: string, value: unknown) => {
          call.is.push([column, value]);
          return builder;
        },
        lt: (column: string, value: string) => {
          call.lt.push([column, value]);
          return builder;
        },
        in: (column: string, values: string[]) => {
          call.in.push([column, values]);
          return builder;
        },
        order: (column: string) => {
          call.order = column;
          return builder;
        },
        limit: (value: number) => {
          call.limit = value;
          return builder;
        },
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(run()).then(resolve, reject),
      };
      return builder;
    },
    rpc: async (name: string) => {
      mock.rpcCalls.push(name);
      return { data: 0, error: null };
    },
  };

  return { client: client as unknown as SupabaseClient, tables, calls };
}

beforeEach(() => {
  mock.audit.mockReset();
  mock.logError.mockReset();
  mock.rpcCalls.length = 0;
  mock.admin = null;
  mock.cascade.mockReset();
  mock.cascade.mockResolvedValue({
    examinados: 0,
    comResiduo: 0,
    completados: [],
    temResto: false,
    falhas: [],
  });
});

describe("deleteUnmatchedClicks", () => {
  it("keeps the retention at 90 days", () => {
    expect(UNMATCHED_CLICK_RETENTION_DAYS).toBe(90);
    expect(CLICK_RETENTION_BATCH_SIZE).toBe(500);
    expect(CLICK_RETENTION_MAX_BATCHES).toBe(20);
    expect([...CLICK_REF_TABLES]).toEqual([GOOGLE, META]);
  });

  it("targets only unmatched rows older than 90 days, in both tables", async () => {
    const { client, calls } = fakeAdmin({
      [GOOGLE]: oldUnmatched(GOOGLE, 3),
      [META]: oldUnmatched(META, 2),
    });

    await deleteUnmatchedClicks(client, NOW);

    expect(new Set(calls.map((call) => call.table))).toEqual(new Set([GOOGLE, META]));
    for (const call of calls) {
      // Every select and every delete carries both filters: never a matched
      // click, never a click of a tracked link.
      expect(call.is, `${call.op} on ${call.table}`).toEqual([
        ["matched_at", null],
        ["tracking_link_id", null],
      ]);
    }
    for (const call of calls.filter((c) => c.op === "select")) {
      expect(call.lt).toEqual([["created_at", CUTOFF]]);
      expect(call.order).toBe("created_at");
      expect(call.limit).toBe(500);
    }
    for (const call of calls.filter((c) => c.op === "delete")) {
      // Deleted by id list only: no age filter that could widen it.
      expect(call.in).toHaveLength(1);
      expect(call.in[0]?.[0]).toBe("id");
      expect(call.lt).toEqual([]);
    }
  });

  it("deletes the old unmatched rows and nothing else", async () => {
    const rows = (table: string): Row[] => [
      { id: `${table}-old-unmatched`, created_at: daysAgo(91), matched_at: null },
      { id: `${table}-old-matched`, created_at: daysAgo(400), matched_at: daysAgo(399) },
      // A click of a tracked link, unmatched and old: its metrics keep it.
      {
        id: `${table}-old-tracked`,
        created_at: daysAgo(300),
        matched_at: null,
        tracking_link_id: "link-1",
      },
      { id: `${table}-recent-unmatched`, created_at: daysAgo(10), matched_at: null },
      { id: `${table}-edge-89`, created_at: daysAgo(89), matched_at: null },
      // Exactly at the cutoff is not older than the cutoff.
      { id: `${table}-at-cutoff`, created_at: CUTOFF, matched_at: null },
      {
        id: `${table}-just-before`,
        created_at: new Date(Date.parse(CUTOFF) - 1).toISOString(),
        matched_at: null,
      },
    ];
    const { client, tables } = fakeAdmin({ [GOOGLE]: rows(GOOGLE), [META]: rows(META) });

    const result = await deleteUnmatchedClicks(client, NOW);

    expect(result).toEqual({ deleted: { [GOOGLE]: 2, [META]: 2 }, failures: [] });
    for (const table of [GOOGLE, META]) {
      expect(tables[table]?.map((row) => row.id).sort()).toEqual(
        [
          `${table}-old-matched`,
          `${table}-old-tracked`,
          `${table}-recent-unmatched`,
          `${table}-edge-89`,
          `${table}-at-cutoff`,
        ].sort(),
      );
    }
  });

  it("never deletes a click that gets matched between the select and the delete", async () => {
    const { client, tables } = fakeAdmin(
      { [GOOGLE]: oldUnmatched(GOOGLE, 3), [META]: [] },
      {
        beforeDelete: (table) => {
          // The WhatsApp message arrives right now: the click is stamped.
          const row = tables[table]?.find((r) => r.id === `${GOOGLE}-old-1`);
          if (row) row.matched_at = NOW.toISOString();
        },
      },
    );

    const result = await deleteUnmatchedClicks(client, NOW);

    expect(result.deleted[GOOGLE]).toBe(2);
    expect(tables[GOOGLE]?.map((row) => row.id)).toEqual([`${GOOGLE}-old-1`]);
  });

  it("keeps the clicks of tracked links, in both tables, whatever their age", async () => {
    const rows = (table: string): Row[] => [
      { ...oldUnmatched(table, 1, "plain")[0]! },
      { ...oldUnmatched(table, 1, "tracked")[0]!, tracking_link_id: "link-1" },
      {
        ...oldUnmatched(table, 1, "tracked-matched")[0]!,
        tracking_link_id: "link-1",
        matched_at: daysAgo(100),
      },
    ];
    const { client, tables } = fakeAdmin({ [GOOGLE]: rows(GOOGLE), [META]: rows(META) });

    const result = await deleteUnmatchedClicks(client, NOW);

    expect(result.deleted).toEqual({ [GOOGLE]: 1, [META]: 1 });
    for (const table of [GOOGLE, META]) {
      expect(tables[table]?.map((row) => row.id).sort()).toEqual(
        [`${table}-tracked-0`, `${table}-tracked-matched-0`].sort(),
      );
    }
  });

  it("tracked-link clicks do not clog the batches: the filter is in the select", async () => {
    // The tracked rows are the OLDEST, so a select without the filter would
    // fill every batch with rows the delete refuses, and never reach the others.
    const tracked = oldUnmatched(GOOGLE, 600, "tracked").map((row) => ({
      ...row,
      created_at: daysAgo(300, Number(row.id.split("-").pop()) * 1000),
      tracking_link_id: "link-1",
    }));
    const { client, tables } = fakeAdmin({
      [GOOGLE]: [...tracked, ...oldUnmatched(GOOGLE, 50, "plain")],
      [META]: [],
    });

    const result = await deleteUnmatchedClicks(client, NOW);

    expect(result.deleted[GOOGLE]).toBe(50);
    expect(tables[GOOGLE]).toHaveLength(600);
    expect(tables[GOOGLE]?.every((row) => row.tracking_link_id === "link-1")).toBe(true);
  });

  it("never deletes a click that is tied to a tracked link between the select and the delete", async () => {
    const { client, tables } = fakeAdmin(
      { [GOOGLE]: oldUnmatched(GOOGLE, 3), [META]: [] },
      {
        beforeDelete: (table) => {
          const row = tables[table]?.find((r) => r.id === `${GOOGLE}-old-1`);
          if (row) row.tracking_link_id = "link-1";
        },
      },
    );

    const result = await deleteUnmatchedClicks(client, NOW);

    expect(result.deleted[GOOGLE]).toBe(2);
    expect(tables[GOOGLE]?.map((row) => row.id)).toEqual([`${GOOGLE}-old-1`]);
  });

  it("an empty table costs one select and no delete", async () => {
    const { client, calls } = fakeAdmin({ [GOOGLE]: [], [META]: [] });

    const result = await deleteUnmatchedClicks(client, NOW);

    expect(result).toEqual({ deleted: { [GOOGLE]: 0, [META]: 0 }, failures: [] });
    expect(calls.map((call) => `${call.table}:${call.op}`)).toEqual([
      `${GOOGLE}:select`,
      `${META}:select`,
    ]);
  });

  it("loops while a batch is full and stops at the first short one", async () => {
    const { client, calls, tables } = fakeAdmin({
      [GOOGLE]: oldUnmatched(GOOGLE, 1250),
      [META]: [],
    });

    const result = await deleteUnmatchedClicks(client, NOW);

    expect(result.deleted[GOOGLE]).toBe(1250);
    expect(tables[GOOGLE]).toHaveLength(0);
    // 500 + 500 + 250: three selects, the third is short, so no fourth.
    expect(calls.filter((c) => c.table === GOOGLE && c.op === "select")).toHaveLength(3);
  });

  it("a batch of exactly 500 asks once more, and stops on the empty answer", async () => {
    const { client, calls } = fakeAdmin({ [GOOGLE]: oldUnmatched(GOOGLE, 500), [META]: [] });

    const result = await deleteUnmatchedClicks(client, NOW);

    expect(result.deleted[GOOGLE]).toBe(500);
    expect(calls.filter((c) => c.table === GOOGLE && c.op === "select")).toHaveLength(2);
  });

  it("deletes by id list in chunks small enough for the gateway URL", async () => {
    const { client, calls } = fakeAdmin({ [GOOGLE]: oldUnmatched(GOOGLE, 500), [META]: [] });

    await deleteUnmatchedClicks(client, NOW);

    const deletes = calls.filter((c) => c.table === GOOGLE && c.op === "delete");
    // 500 uuids in one URL are ~19 KB; the gateway answers 414 above 8 KB.
    expect(deletes).toHaveLength(5);
    for (const call of deletes) expect(call.in[0]?.[1].length).toBeLessThanOrEqual(100);
  });

  it("runs at most 20 batches per table per run, and leaves the rest for tomorrow", async () => {
    const total = CLICK_RETENTION_BATCH_SIZE * (CLICK_RETENTION_MAX_BATCHES + 4);
    const { client, calls, tables } = fakeAdmin({
      [GOOGLE]: oldUnmatched(GOOGLE, total),
      [META]: oldUnmatched(META, 10),
    });

    const result = await deleteUnmatchedClicks(client, NOW);

    expect(calls.filter((c) => c.table === GOOGLE && c.op === "select")).toHaveLength(20);
    expect(result.deleted[GOOGLE]).toBe(10_000);
    expect(tables[GOOGLE]).toHaveLength(total - 10_000);
    // The cap is per table: the other one still ran.
    expect(result.deleted[META]).toBe(10);
  });

  it("a failing select surfaces and the other table is still cleaned", async () => {
    const { client, tables } = fakeAdmin(
      { [GOOGLE]: oldUnmatched(GOOGLE, 4), [META]: oldUnmatched(META, 4) },
      { failSelect: { [GOOGLE]: "permission denied" } },
    );

    const result = await deleteUnmatchedClicks(client, NOW);

    expect(result.failures).toEqual([`${GOOGLE}: permission denied`]);
    expect(result.deleted).toEqual({ [GOOGLE]: 0, [META]: 4 });
    expect(tables[GOOGLE]).toHaveLength(4);
    expect(tables[META]).toHaveLength(0);
  });

  it("a failing delete surfaces, keeps the exact count of what went before, and spares the other table", async () => {
    // 250 rows is three chunks; the third delete call fails.
    const { client, tables } = fakeAdmin(
      { [GOOGLE]: oldUnmatched(GOOGLE, 250), [META]: oldUnmatched(META, 5) },
      { failNthDelete: 3 },
    );

    const result = await deleteUnmatchedClicks(client, NOW);

    expect(result.failures).toEqual([`${GOOGLE}: delete failed`]);
    expect(result.deleted[GOOGLE]).toBe(200);
    expect(tables[GOOGLE]).toHaveLength(50);
    expect(result.deleted[META]).toBe(5);
  });
});

describe("runUnmatchedClickRetention", () => {
  it("a run that deleted nothing leaves no audit line and no error", async () => {
    const { client } = fakeAdmin({ [GOOGLE]: [], [META]: [] });

    const report = await runUnmatchedClickRetention("req-1", client);

    expect(report).toEqual({
      unmatched_clicks_deleted: { [GOOGLE]: 0, [META]: 0 },
      unmatched_clicks_failures: 0,
    });
    expect(mock.audit).not.toHaveBeenCalled();
    expect(mock.logError).not.toHaveBeenCalled();
  });

  it("a run that deleted something is audited, without a failure flag", async () => {
    const { client } = fakeAdmin({
      [GOOGLE]: oldUnmatched(GOOGLE, 3),
      [META]: oldUnmatched(META, 1),
    });

    const report = await runUnmatchedClickRetention("req-1", client);

    expect(report.unmatched_clicks_deleted).toEqual({ [GOOGLE]: 3, [META]: 1 });
    expect(mock.audit).toHaveBeenCalledTimes(1);
    const entry = mock.audit.mock.calls[0]?.[0] as { metadata: Record<string, unknown> };
    expect(entry).toMatchObject({
      action: "retention.sweep_run",
      organizationId: null,
      bypassedRls: true,
      requestId: "req-1",
      metadata: {
        origem: "ad-click-refs",
        retention_days: 90,
        unmatched_clicks_deleted: { [GOOGLE]: 3, [META]: 1 },
      },
    });
    expect(entry.metadata).not.toHaveProperty("falhou");
  });

  it("never throws: a failure is logged, audited as falhou and reported", async () => {
    const { client } = fakeAdmin(
      { [GOOGLE]: oldUnmatched(GOOGLE, 2), [META]: oldUnmatched(META, 2) },
      { failSelect: { [GOOGLE]: "boom" } },
    );

    const report = await runUnmatchedClickRetention("req-2", client);

    expect(report.unmatched_clicks_failures).toBe(1);
    expect(report.unmatched_clicks_deleted).toEqual({ [GOOGLE]: 0, [META]: 2 });
    expect(mock.logError).toHaveBeenCalledWith(
      "[data-retention] unmatched ad click cleanup failed",
      { error: `${GOOGLE}: boom`, requestId: "req-2" },
    );
    expect(mock.audit.mock.calls[0]?.[0]).toMatchObject({
      action: "retention.sweep_run",
      metadata: { falhou: true, erro: `${GOOGLE}: boom` },
    });
  });

  it("never throws when there is no admin client at all", async () => {
    mock.admin = null; // the mocked `createAdminClient` throws

    const report = await runUnmatchedClickRetention("req-3");

    expect(report.unmatched_clicks_failures).toBe(1);
    expect(mock.logError).toHaveBeenCalledTimes(1);
    expect(mock.audit.mock.calls[0]?.[0]).toMatchObject({
      metadata: { falhou: true, erro: "service role key missing" },
    });
  });
});

describe("the data-retention cron with the cleanup hooked in", () => {
  const request = (authorized: boolean) =>
    ({
      headers: new Headers(authorized ? { authorization: "Bearer segredo" } : {}),
    }) as never;

  it("reports the cleanup in the response, next to the other steps", async () => {
    const { client, tables } = fakeAdmin({
      [GOOGLE]: oldUnmatched(GOOGLE, 3),
      [META]: oldUnmatched(META, 2),
      conversation_drafts: [],
    });
    mock.admin = client;

    const response = await GET(request(true));
    const body = (await response.json()) as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.data.unmatched_clicks_deleted).toEqual({ [GOOGLE]: 3, [META]: 2 });
    expect(body.data.unmatched_clicks_failures).toBe(0);
    expect(tables[GOOGLE]).toHaveLength(0);
    // The upstream steps still ran and still report.
    expect(mock.rpcCalls).toContain("fn_podar_fila_de_jobs");
    expect(body.data).toHaveProperty("jobs_apagados");
    expect(mock.cascade).toHaveBeenCalledTimes(1);
  });

  it("a failing cleanup does not stop the other steps, and is logged", async () => {
    const { client } = fakeAdmin(
      { [GOOGLE]: [], [META]: [], conversation_drafts: [] },
      { failSelect: { [GOOGLE]: "boom", [META]: "boom" } },
    );
    mock.admin = client;

    const response = await GET(request(true));
    const body = (await response.json()) as { data: Record<string, unknown> };

    // Not a 500: the prune and the anonymization sweep ran as usual.
    expect(response.status).toBe(200);
    expect(body.data.unmatched_clicks_failures).toBe(2);
    expect(mock.rpcCalls).toContain("fn_podar_fila_de_jobs");
    expect(mock.rpcCalls).toContain("fn_expurgar_candidatos_do_golden");
    expect(mock.cascade).toHaveBeenCalledTimes(1);
    expect(mock.logError).toHaveBeenCalledTimes(2);
    const actions = mock.audit.mock.calls.map(
      (call) => (call[0] as { metadata: { origem?: string } }).metadata.origem,
    );
    expect(actions).toEqual(["ad-click-refs"]);
  });

  it("an unauthorized request never reaches the cleanup", async () => {
    const { client, calls } = fakeAdmin({ [GOOGLE]: oldUnmatched(GOOGLE, 3), [META]: [] });
    mock.admin = client;

    const response = await GET(request(false));

    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});
