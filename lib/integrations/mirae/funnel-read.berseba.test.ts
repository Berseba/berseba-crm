// @vitest-environment node
/**
 * Berseba: the Mirae read routes (`GET /api/v1/mirae/leads`, `GET /api/v1/mirae/pipelines`).
 *
 * The routes run for real against an in-memory database that honours the PostgREST filters the
 * code sends (`eq`, `in`, `gte`, `lt`, `order`, `limit` and the `or=` logic tree, with SQL's
 * `NOT IN` + NULL semantics). Only the token lookup and the rate-limit counter are doubles, so
 * what is proved is the route's own scoping: the organization from the token, never the query.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { env } from "@/lib/env";
import { McpAuthError } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";

import { PAGE_SIZE, encodeCursor } from "./funnel-read";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});
const { validateBearerToken } = await import("@/lib/mcp/auth");
const { GET: getLeads } = await import("@/app/api/v1/mirae/leads/route");
const { GET: getPipelines } = await import("@/app/api/v1/mirae/pipelines/route");

// ─── in-memory PostgREST ─────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Pred = (r: Row) => boolean;

const TIME_COLUMNS = new Set(["created_at", "last_message_at"]);

function compare(col: string, a: unknown, b: unknown): number {
  if (TIME_COLUMNS.has(col)) return Date.parse(String(a)) - Date.parse(String(b));
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** Splits on the commas that are not inside parentheses. */
function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

function parseNode(s: string): Pred {
  const logic = /^(and|or)\((.*)\)$/s.exec(s);
  if (logic) {
    const kids = splitTop(logic[2]!).map(parseNode);
    return logic[1] === "and" ? (r) => kids.every((k) => k(r)) : (r) => kids.some((k) => k(r));
  }
  const notIn = /^(\w+)\.not\.in\.\((.*)\)$/.exec(s);
  if (notIn) {
    const col = notIn[1]!;
    const ids = notIn[2]!.split(",");
    // SQL: `NULL NOT IN (…)` is NULL, so the row does not pass.
    return (r) => r[col] != null && !ids.includes(String(r[col]));
  }
  const leaf = /^(\w+)\.(eq|gt|lt|is)\.(.*)$/.exec(s);
  if (!leaf) throw new Error(`fake PostgREST: unsupported filter ${s}`);
  const [, col, op, value] = leaf as unknown as [string, string, string, string];
  if (op === "is") return (r) => (value === "null" ? r[col] == null : String(r[col]) === value);
  if (op === "eq") return (r) => r[col] != null && compare(col, r[col], value) === 0;
  if (op === "gt") return (r) => r[col] != null && compare(col, r[col], value) > 0;
  return (r) => r[col] != null && compare(col, r[col], value) < 0;
}

interface Db {
  tables: Record<string, Row[]>;
  selects: Record<string, string[]>;
  inSizes: number[];
  /** A table whose queries answer with a database error. */
  failing?: string;
}

function fakeSupabase(db: Db) {
  return {
    from(table: string) {
      const preds: Pred[] = [];
      const orders: Array<{ col: string; asc: boolean }> = [];
      let limit = Number.POSITIVE_INFINITY;
      let columns = "*";
      let single = false;
      const run = () => {
        if (db.failing === table) return { data: null, error: { message: "boom" } };
        let rows = (db.tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
        rows = [...rows].sort((a, b) => {
          for (const { col, asc } of orders) {
            if (a[col] == null && b[col] == null) continue;
            if (a[col] == null) return 1; // nulls last
            if (b[col] == null) return -1;
            const c = compare(col, a[col], b[col]);
            if (c !== 0) return asc ? c : -c;
          }
          return 0;
        });
        rows = rows.slice(0, limit);
        const cols = columns.split(",").map((c) => c.trim());
        const projected = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
        return { data: single ? (projected[0] ?? null) : projected, error: null };
      };
      const builder = {
        select(c: string) {
          columns = c;
          (db.selects[table] ??= []).push(c);
          return builder;
        },
        eq(col: string, v: unknown) {
          preds.push((r) => r[col] === v);
          return builder;
        },
        in(col: string, vs: unknown[]) {
          db.inSizes.push(vs.length);
          preds.push((r) => vs.includes(r[col]));
          return builder;
        },
        gte(col: string, v: string) {
          preds.push((r) => compare(col, r[col], v) >= 0);
          return builder;
        },
        lt(col: string, v: string) {
          preds.push((r) => compare(col, r[col], v) < 0);
          return builder;
        },
        or(filters: string) {
          preds.push(parseNode(`or(${filters})`));
          return builder;
        },
        order(col: string, opts?: { ascending?: boolean }) {
          orders.push({ col, asc: opts?.ascending !== false });
          return builder;
        },
        limit(n: number) {
          limit = n;
          return builder;
        },
        maybeSingle() {
          single = true;
          return builder;
        },
        then<T>(resolve: (v: ReturnType<typeof run>) => T, reject?: (e: unknown) => T) {
          return Promise.resolve().then(run).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

// ─── fixtures ────────────────────────────────────────────────────────────────

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const PIPE_A = uuid(1);
const PIPE_A_ARCHIVED = uuid(2);
const PIPE_B = uuid(3);
const ST_NEW = uuid(11);
const ST_EVAL = uuid(12);
const ST_WON = uuid(13);
const ST_LOST = uuid(14);
const ST_ARCHIVED = uuid(15);
const ST_B = uuid(16);
const C_MARIA = uuid(21);
const C_PERSONAL = uuid(22);
const C_B = uuid(23);
const L_OPEN = uuid(31);
const L_NO_CONTACT = uuid(32);
const L_PERSONAL = uuid(33);
const L_LOST = uuid(34);
const L_OUT_OF_RANGE = uuid(35);
const L_B = uuid(36);
const L_B_IN_PIPE_A = uuid(37);

function lead(over: Row): Row {
  return {
    organization_id: ORG_A,
    pipeline_id: PIPE_A,
    stage_id: ST_NEW,
    status: "open",
    closed_at: null,
    lost_reason: null,
    lost_from_stage_id: null,
    contact_id: null,
    source: "manual",
    source_metadata: {},
    title: "Maria Souza — avaliação",
    description: "secret description",
    custom_fields: { cpf: "123.456.789-00" },
    ...over,
  };
}

function baseTables(): Record<string, Row[]> {
  return {
    crm_pipelines: [
      {
        id: PIPE_A,
        organization_id: ORG_A,
        name: "Novos alunos",
        is_default: true,
        is_archived: false,
        position: 1,
      },
      {
        id: PIPE_A_ARCHIVED,
        organization_id: ORG_A,
        name: "Antigo",
        is_default: false,
        is_archived: true,
        position: 0,
      },
      {
        id: PIPE_B,
        organization_id: ORG_B,
        name: "Outro estúdio",
        is_default: true,
        is_archived: false,
        position: 1,
      },
    ],
    crm_stages: [
      {
        id: ST_EVAL,
        organization_id: ORG_A,
        pipeline_id: PIPE_A,
        name: "Avaliação agendada",
        position: 2,
        is_won: false,
        is_lost: false,
        is_archived: false,
      },
      {
        id: ST_NEW,
        organization_id: ORG_A,
        pipeline_id: PIPE_A,
        name: "Novo",
        position: 1,
        is_won: false,
        is_lost: false,
        is_archived: false,
      },
      {
        id: ST_WON,
        organization_id: ORG_A,
        pipeline_id: PIPE_A,
        name: "Matriculado",
        position: 3,
        is_won: true,
        is_lost: false,
        is_archived: false,
      },
      {
        id: ST_LOST,
        organization_id: ORG_A,
        pipeline_id: PIPE_A,
        name: "Perdido",
        position: 4,
        is_won: false,
        is_lost: true,
        is_archived: false,
      },
      {
        id: ST_ARCHIVED,
        organization_id: ORG_A,
        pipeline_id: PIPE_A,
        name: "Velha",
        position: 5,
        is_won: false,
        is_lost: false,
        is_archived: true,
      },
      {
        id: ST_B,
        organization_id: ORG_B,
        pipeline_id: PIPE_B,
        name: "Entrada B",
        position: 1,
        is_won: false,
        is_lost: false,
        is_archived: false,
      },
    ],
    contacts: [
      {
        id: C_MARIA,
        organization_id: ORG_A,
        name: "Maria Souza",
        display_name: "Maria",
        email: "maria@example.com",
        cpf_encrypted: "enc",
        phone_number: "+5511999990001",
        tags: ["gestante"],
        source: "whatsapp",
        source_metadata: { utm_source: "instagram", utm_campaign: "outubro-gestantes" },
        custom_fields: { secret: true },
        is_personal: false,
      },
      {
        id: C_PERSONAL,
        organization_id: ORG_A,
        phone_number: "+5511999990002",
        tags: [],
        source: "whatsapp",
        source_metadata: {},
        is_personal: true,
      },
      {
        id: C_B,
        organization_id: ORG_B,
        phone_number: "+5511999990003",
        tags: ["b"],
        source: "whatsapp",
        source_metadata: {},
        is_personal: false,
      },
    ],
    conversations: [
      {
        contact_id: C_MARIA,
        organization_id: ORG_A,
        is_group: false,
        last_message_at: "2026-10-05T10:00:00.000Z",
        last_inbound_at: "2026-10-05T10:00:00.000Z",
        last_outbound_at: "2026-10-05T09:00:00.000Z",
        last_message_preview: "secret text",
      },
      {
        contact_id: C_MARIA,
        organization_id: ORG_A,
        is_group: false,
        last_message_at: "2026-09-01T10:00:00.000Z",
        last_inbound_at: "2026-09-01T10:00:00.000Z",
        last_outbound_at: null,
      },
      {
        contact_id: C_MARIA,
        organization_id: ORG_A,
        is_group: true,
        last_message_at: "2026-10-20T10:00:00.000Z",
        last_inbound_at: "2026-10-20T10:00:00.000Z",
        last_outbound_at: "2026-10-20T10:00:00.000Z",
      },
    ],
    crm_leads: [
      lead({
        id: L_OPEN,
        contact_id: C_MARIA,
        stage_id: ST_EVAL,
        created_at: "2026-10-01T12:00:00.000Z",
      }),
      lead({
        id: L_NO_CONTACT,
        source: "site",
        source_metadata: { utm_source: "google", utm_campaign: "lp" },
        created_at: "2026-10-02T12:00:00.000Z",
      }),
      lead({ id: L_PERSONAL, contact_id: C_PERSONAL, created_at: "2026-10-03T12:00:00.000Z" }),
      lead({
        id: L_LOST,
        contact_id: C_MARIA,
        stage_id: ST_LOST,
        status: "lost",
        lost_reason: "Preço",
        lost_from_stage_id: ST_EVAL,
        closed_at: "2026-10-10T12:00:00.000Z",
        created_at: "2026-10-04T12:00:00.000Z",
      }),
      lead({ id: L_OUT_OF_RANGE, created_at: "2026-11-15T12:00:00.000Z" }),
      lead({
        id: L_B,
        organization_id: ORG_B,
        pipeline_id: PIPE_B,
        stage_id: ST_B,
        contact_id: C_B,
        created_at: "2026-10-01T12:00:00.000Z",
      }),
      // Inconsistent row on purpose: another organization's lead pointing at org A's pipeline.
      lead({
        id: L_B_IN_PIPE_A,
        organization_id: ORG_B,
        contact_id: C_B,
        created_at: "2026-10-01T13:00:00.000Z",
      }),
    ],
  };
}

let db: Db;

function token(over: { organizationId?: string; scopes?: string[] } = {}): void {
  // Like the real one: no `Bearer …` header is a 401 from the validator itself.
  vi.mocked(validateBearerToken).mockImplementation(async (header) => {
    if (!header?.startsWith("Bearer ")) {
      throw new McpAuthError(-32001, 401, "Missing or malformed Authorization header.");
    }
    return {
      organizationId: over.organizationId ?? ORG_A,
      role: "agent",
      actor: { type: "ai_agent", id: "run-1", role: "agent", api_token_id: "tok-1" } as never,
      apiTokenId: "tok-1",
      scopes: over.scopes ?? ["mcp:read"],
    };
  });
}

const RANGE = "created_from=2026-10-01T00:00:00Z&created_to=2026-11-01T00:00:00Z";

function leadsReq(query: string, auth: string | null = "Bearer dsk_abc_def") {
  return new NextRequest(`https://crm.example/api/v1/mirae/leads?${query}`, {
    headers: auth ? { authorization: auth } : {},
  });
}

type LeadsBody = { data: Array<Record<string, unknown>>; next_cursor: string | null };

beforeEach(() => {
  vi.clearAllMocks();
  db = { tables: baseTables(), selects: {}, inSizes: [] };
  vi.mocked(createAdminClient).mockReturnValue(fakeSupabase(db) as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    count: 1,
    limit: 60,
    window_sec: 60,
  });
  token();
});

// ─── auth ────────────────────────────────────────────────────────────────────

describe("auth (both routes)", () => {
  it.each([
    ["leads", () => getLeads(leadsReq(`pipeline_id=${PIPE_A}&${RANGE}`, null))],
    [
      "pipelines",
      () => getPipelines(new NextRequest("https://crm.example/api/v1/mirae/pipelines")),
    ],
  ])(
    "%s: no Bearer → 401 from the validator (counted as a failed attempt), no data read",
    async (_name, call) => {
      const res = await call();
      expect(res.status).toBe(401);
      expect(validateBearerToken).toHaveBeenCalledWith(null);
      expect(createAdminClient).not.toHaveBeenCalled();
    },
  );

  it("a session cookie is not a way in: still 401", async () => {
    const res = await getLeads(
      new NextRequest(`https://crm.example/api/v1/mirae/leads?pipeline_id=${PIPE_A}&${RANGE}`, {
        headers: { cookie: "sb-access-token=whatever" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("invalid or revoked token → 401", async () => {
    vi.mocked(validateBearerToken).mockRejectedValue(
      new McpAuthError(-32001, 401, "Token not recognized."),
    );
    const res = await getLeads(leadsReq(`pipeline_id=${PIPE_A}&${RANGE}`));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthenticated");
  });

  it.each([
    ["leads", () => getLeads(leadsReq(`pipeline_id=${PIPE_A}&${RANGE}`))],
    [
      "pipelines",
      () =>
        getPipelines(
          new NextRequest("https://crm.example/api/v1/mirae/pipelines", {
            headers: { authorization: "Bearer dsk_a_b" },
          }),
        ),
    ],
  ])("%s: token without mcp:read → 403, nothing read", async (_name, call) => {
    token({ scopes: ["mcp:write"] });
    const res = await call();
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden_role");
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("over the read ceiling → 429 with Retry-After, in Mirae's own buckets", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      count: 61,
      limit: 60,
      window_sec: 60,
    });
    const res = await getLeads(leadsReq(`pipeline_id=${PIPE_A}&${RANGE}`));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(vi.mocked(checkRateLimit).mock.calls[0]?.[0]).toBe("mirae-read:tok:tok-1");
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
  });
});

// ─── query validation ────────────────────────────────────────────────────────

describe("GET /api/v1/mirae/leads — query validation (422)", () => {
  const tampered = Buffer.from(
    JSON.stringify({ created_at: "2026-10-01T00:00:00Z,id.gt.0", id: L_OPEN }),
    "utf8",
  ).toString("base64url");
  const impossibleDate = Buffer.from(
    JSON.stringify({ created_at: "2026-99-99T99:99:99Z", id: L_OPEN }),
    "utf8",
  ).toString("base64url");

  it.each([
    ["no pipeline_id", RANGE],
    [
      "cursor with a date that does not exist",
      `pipeline_id=${PIPE_A}&${RANGE}&cursor=${impossibleDate}`,
    ],
    ["pipeline_id not a uuid", `pipeline_id=abc&${RANGE}`],
    ["no created_from", `pipeline_id=${PIPE_A}&created_to=2026-11-01T00:00:00Z`],
    ["no created_to", `pipeline_id=${PIPE_A}&created_from=2026-10-01T00:00:00Z`],
    [
      "date that is not ISO 8601",
      `pipeline_id=${PIPE_A}&created_from=01/10/2026&created_to=2026-11-01T00:00:00Z`,
    ],
    [
      "from after to",
      `pipeline_id=${PIPE_A}&created_from=2026-11-01T00:00:00Z&created_to=2026-10-01T00:00:00Z`,
    ],
    [
      "empty range",
      `pipeline_id=${PIPE_A}&created_from=2026-10-01T00:00:00Z&created_to=2026-10-01T00:00:00Z`,
    ],
    [
      "range over 400 days",
      `pipeline_id=${PIPE_A}&created_from=2025-09-25T00:00:00Z&created_to=2026-11-01T00:00:00Z`,
    ],
    ["garbage cursor", `pipeline_id=${PIPE_A}&${RANGE}&cursor=not-a-cursor`],
    ["cursor smuggling a filter", `pipeline_id=${PIPE_A}&${RANGE}&cursor=${tampered}`],
  ])("%s → 422, nothing read", async (_name, query) => {
    const res = await getLeads(leadsReq(query));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "validation_failed",
    );
    expect(db.selects.crm_leads).toBeUndefined();
  });

  it("exactly 400 days is accepted", async () => {
    const res = await getLeads(
      leadsReq(
        `pipeline_id=${PIPE_A}&created_from=2025-09-26T00:00:00Z&created_to=2026-10-31T00:00:00Z`,
      ),
    );
    expect(res.status).toBe(200);
  });
});

// ─── tenant isolation ────────────────────────────────────────────────────────

describe("GET /api/v1/mirae/leads — cross-tenant", () => {
  it("org A's token on org B's pipeline → 404, same as a pipeline that does not exist", async () => {
    const other = await getLeads(leadsReq(`pipeline_id=${PIPE_B}&${RANGE}`));
    const missing = await getLeads(leadsReq(`pipeline_id=${uuid(999)}&${RANGE}`));
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await other.json()).toMatchObject({ error: { code: "not_found" } });
    expect(db.selects.crm_leads).toBeUndefined();
  });

  it("org A's token never reads org B's leads, even one pointing at org A's pipeline", async () => {
    const res = await getLeads(leadsReq(`pipeline_id=${PIPE_A}&${RANGE}`));
    const ids = ((await res.json()) as LeadsBody).data.map((l) => l.id);
    expect(ids).not.toContain(L_B);
    expect(ids).not.toContain(L_B_IN_PIPE_A);
    expect(JSON.stringify(ids)).not.toContain(C_B);
  });

  it("org B's token reads org B's pipeline and only org B's leads", async () => {
    token({ organizationId: ORG_B });
    const res = await getLeads(leadsReq(`pipeline_id=${PIPE_B}&${RANGE}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as LeadsBody;
    expect(body.data.map((l) => l.id)).toEqual([L_B]);
  });
});

// ─── content ─────────────────────────────────────────────────────────────────

describe("GET /api/v1/mirae/leads — items", () => {
  async function page(): Promise<LeadsBody> {
    const res = await getLeads(leadsReq(`pipeline_id=${PIPE_A}&${RANGE}`));
    expect(res.status).toBe(200);
    return (await res.json()) as LeadsBody;
  }

  it("lists the range [from, to) in created_at order, personal contact excluded, lead without contact kept", async () => {
    const body = await page();
    expect(body.data.map((l) => l.id)).toEqual([L_OPEN, L_NO_CONTACT, L_LOST]);
    expect(body.next_cursor).toBeNull();
  });

  it("an open lead with a contact carries stage, origin, E.164 phone, last messages and card url", async () => {
    const [open] = (await page()).data;
    expect(open).toEqual({
      id: L_OPEN,
      created_at: "2026-10-01T12:00:00.000Z",
      closed_at: null,
      status: "open",
      stage: { id: ST_EVAL, name: "Avaliação agendada", is_won: false, is_lost: false },
      lost_reason: null,
      lost_from_stage: null,
      origin: { source: "instagram", campaign: "outubro-gestantes" },
      contact: { phone: "+5511999990001" },
      // The latest across the 1:1 conversations; the newer GROUP conversation does not count.
      last_inbound_at: "2026-10-05T10:00:00.000Z",
      last_outbound_at: "2026-10-05T09:00:00.000Z",
      url: `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/app/leads/${L_OPEN}`,
    });
  });

  it("a lost lead carries the reason and the stage it was lost from", async () => {
    const lost = (await page()).data.find((l) => l.id === L_LOST);
    expect(lost).toMatchObject({
      status: "lost",
      closed_at: "2026-10-10T12:00:00.000Z",
      stage: { id: ST_LOST, name: "Perdido", is_won: false, is_lost: true },
      lost_reason: "Preço",
      lost_from_stage: { id: ST_EVAL, name: "Avaliação agendada" },
    });
  });

  it("a lead without a contact: phone null, origin from the lead's own source", async () => {
    const orphan = (await page()).data.find((l) => l.id === L_NO_CONTACT);
    expect(orphan).toMatchObject({
      contact: { phone: null },
      origin: { source: "google", campaign: "lp" },
      last_inbound_at: null,
      last_outbound_at: null,
    });
  });

  it("never returns name, e-mail, CPF, message text, title, custom fields or tags", async () => {
    const body = await page();
    const allowed = [
      "closed_at",
      "contact",
      "created_at",
      "id",
      "last_inbound_at",
      "last_outbound_at",
      "lost_from_stage",
      "lost_reason",
      "origin",
      "stage",
      "status",
      "url",
    ];
    for (const item of body.data) {
      expect(Object.keys(item).sort()).toEqual(allowed);
      expect(Object.keys(item.contact as object).sort()).toEqual(["phone"]);
    }
    const text = JSON.stringify(body);
    for (const secret of ["Maria", "maria@example.com", "123.456.789", "secret", '"gestante"']) {
      expect(text).not.toContain(secret);
    }
    // And they are not even read from the database (stage and funnel names are fine).
    const read = [
      ...db.selects.crm_leads!,
      ...db.selects.contacts!,
      ...db.selects.conversations!,
    ].join(",");
    for (const column of [
      "name",
      "display_name",
      "email",
      "cpf",
      "custom_fields",
      "last_message_preview",
      "title",
      "description",
      "tags",
    ]) {
      expect(read.split(",").map((c) => c.trim())).not.toContain(column);
    }
  });

  it("the batch lookups are one query per table per page (no N+1)", async () => {
    // Many leads of the same contact: still one contacts and one conversations query.
    for (let i = 0; i < 50; i++) {
      db.tables.crm_leads!.push(
        lead({
          id: uuid(5000 + i),
          contact_id: C_MARIA,
          created_at: `2026-10-0${(i % 9) + 1}T15:00:00.000Z`,
        }),
      );
    }
    await page();
    expect(db.selects.contacts).toHaveLength(1);
    expect(db.selects.conversations).toHaveLength(1);
    expect(db.selects.crm_stages).toHaveLength(1);
  });

  it("last inbound and last outbound are each the latest across the 1:1 conversations", async () => {
    // The studio wrote today from another number, where the client never answered.
    db.tables.conversations!.push({
      contact_id: C_MARIA,
      organization_id: ORG_A,
      is_group: false,
      last_message_at: "2026-10-08T10:00:00.000Z",
      last_inbound_at: null,
      last_outbound_at: "2026-10-08T10:00:00.000Z",
    });
    const open = (await page()).data.find((l) => l.id === L_OPEN);
    expect(open).toMatchObject({
      last_inbound_at: "2026-10-05T10:00:00.000Z",
      last_outbound_at: "2026-10-08T10:00:00.000Z",
    });
  });

  it("personal contacts stay out however many there are (no id-list ceiling)", async () => {
    for (let i = 0; i < 600; i++) {
      const contactId = uuid(10_000 + i);
      db.tables.contacts!.push({
        id: contactId,
        organization_id: ORG_A,
        phone_number: `+55119${String(i).padStart(8, "0")}`,
        source: "whatsapp",
        source_metadata: {},
        is_personal: true,
      });
      db.tables.crm_leads!.push(
        lead({
          id: uuid(20_000 + i),
          contact_id: contactId,
          created_at: "2026-10-06T12:00:00.000Z",
        }),
      );
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await getLeads(
        leadsReq(`pipeline_id=${PIPE_A}&${RANGE}${cursor ? `&cursor=${cursor}` : ""}`),
      );
      const body = (await res.json()) as LeadsBody;
      seen.push(...body.data.map((l) => String(l.id)));
      cursor = body.next_cursor;
    } while (cursor);
    // Pages made only of personal deals come back empty but keep the cursor going.
    expect(seen).toEqual([L_OPEN, L_NO_CONTACT, L_LOST]);
  });

  it("the contacts lookup failing is a 500, never a page with personal deals in it", async () => {
    db.failing = "contacts";
    const res = await getLeads(leadsReq(`pipeline_id=${PIPE_A}&${RANGE}`));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("boom");
  });
});

// ─── pagination ──────────────────────────────────────────────────────────────

describe("GET /api/v1/mirae/leads — cursor pagination", () => {
  it(`walks ${PAGE_SIZE + 7} leads in pages of ${PAGE_SIZE}, created_at then id, with ties`, async () => {
    db.tables.crm_leads = [];
    const all: string[] = [];
    for (let i = 0; i < PAGE_SIZE + 7; i++) {
      const id = uuid(10_000 + i);
      all.push(id);
      // Pairs share created_at, so the id tie-break is what keeps the walk exact.
      const minute = String(Math.floor(i / 2) % 60).padStart(2, "0");
      const hour = String(Math.floor(i / 120)).padStart(2, "0");
      db.tables.crm_leads.push(lead({ id, created_at: `2026-10-02T${hour}:${minute}:00.000Z` }));
    }
    db.tables.crm_leads.reverse(); // storage order must not matter

    const first = (await (
      await getLeads(leadsReq(`pipeline_id=${PIPE_A}&${RANGE}`))
    ).json()) as LeadsBody;
    expect(first.data).toHaveLength(PAGE_SIZE);
    expect(first.next_cursor).toEqual(expect.any(String));

    const second = (await (
      await getLeads(leadsReq(`pipeline_id=${PIPE_A}&${RANGE}&cursor=${first.next_cursor}`))
    ).json()) as LeadsBody;
    expect(second.data).toHaveLength(7);
    expect(second.next_cursor).toBeNull();

    expect([...first.data, ...second.data].map((l) => l.id)).toEqual(all);
  });

  it("exactly one full page has no next cursor", async () => {
    db.tables.crm_leads = Array.from({ length: PAGE_SIZE }, (_, i) =>
      lead({ id: uuid(20_000 + i), created_at: "2026-10-03T00:00:00.000Z" }),
    );
    const body = (await (
      await getLeads(leadsReq(`pipeline_id=${PIPE_A}&${RANGE}`))
    ).json()) as LeadsBody;
    expect(body.data).toHaveLength(PAGE_SIZE);
    expect(body.next_cursor).toBeNull();
  });

  it("the cursor keeps the personal-contact exclusion and the lead without contact", async () => {
    const cursor = encodeCursor({ created_at: "2026-10-01T12:00:00.000Z", id: L_OPEN });
    const body = (await (
      await getLeads(leadsReq(`pipeline_id=${PIPE_A}&${RANGE}&cursor=${cursor}`))
    ).json()) as LeadsBody;
    expect(body.data.map((l) => l.id)).toEqual([L_NO_CONTACT, L_LOST]);
  });

  it("the id lookups stay within the URL budget", async () => {
    db.tables.crm_leads = Array.from({ length: PAGE_SIZE }, (_, i) =>
      lead({
        id: uuid(30_000 + i),
        contact_id: uuid(40_000 + i),
        created_at: "2026-10-03T00:00:00.000Z",
      }),
    );
    await getLeads(leadsReq(`pipeline_id=${PIPE_A}&${RANGE}`));
    expect(Math.max(...db.inSizes)).toBeLessThanOrEqual(100);
  });
});

// ─── pipelines ───────────────────────────────────────────────────────────────

describe("GET /api/v1/mirae/pipelines", () => {
  const pipelinesReq = () =>
    new NextRequest("https://crm.example/api/v1/mirae/pipelines", {
      headers: { authorization: "Bearer dsk_a_b" },
    });

  it("lists the token's organization live funnels with live stages by position", async () => {
    const res = await getPipelines(pipelinesReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [
        {
          id: PIPE_A,
          name: "Novos alunos",
          is_default: true,
          stages: [
            { id: ST_NEW, name: "Novo", position: 1, is_won: false, is_lost: false },
            { id: ST_EVAL, name: "Avaliação agendada", position: 2, is_won: false, is_lost: false },
            { id: ST_WON, name: "Matriculado", position: 3, is_won: true, is_lost: false },
            { id: ST_LOST, name: "Perdido", position: 4, is_won: false, is_lost: true },
          ],
        },
      ],
    });
  });

  it("org B's token sees only org B's funnel", async () => {
    token({ organizationId: ORG_B });
    const body = (await (await getPipelines(pipelinesReq())).json()) as {
      data: Array<{ id: string; stages: unknown[] }>;
    };
    expect(body.data.map((p) => p.id)).toEqual([PIPE_B]);
    expect(JSON.stringify(body)).not.toContain(ST_NEW);
  });
});
