/**
 * Berseba: the Atos agenda tools (RBCOR). `fetch` is mocked: no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "546430cf-e857-4d2d-b1b6-5754390f8473";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const CONTACT_PHONE = "+55 (14) 99999-0001";
const PHONE = "+5514999990001";
const BASE = "http://rbcor-atos-api:8000";

vi.mock("@/lib/integrations/atos/config", () => {
  const config = {
    baseUrl: "http://rbcor-atos-api:8000",
    apiKey: "atos-test-key",
    orgIds: new Set([ORG]),
  };
  return {
    ATOS_TOOL_PREFIX: "atos_",
    atosConfigFor: (org: string) => (org === ORG ? config : null),
    isAtosToolHiddenFor: (name: string, org: string) => name.startsWith("atos_") && org !== ORG,
  };
});
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn().mockResolvedValue(undefined) }));

const tools = await import("./atos");
const { allTools } = await import("./index");
const { TOOL_CATALOG } = await import("./catalog");
const { pickToolsFromMcp } = await import("@/lib/ai/runtime/tools");
const { ESCOPO_DAS_ESCRITAS } = await import("@/lib/ai/runtime/escopo-das-escritas");
const { ALVO_DE_FUNIL } = await import("@/lib/leads/escopo-de-funil");

type Args = Record<string, unknown>;
type Call = { url: URL; method: string; headers: Record<string, string>; body: unknown };

function slot(date: string, time: string, free = 2) {
  const [h] = time.split(":");
  return {
    id: `${date}-${time.replace(":", "")}`,
    date,
    start_time: time,
    end_time: `${h}:40`,
    starts_at: `${date}T${time}:00-03:00`,
    free,
  };
}

function booking(
  date: string,
  time: string,
  status = "scheduled",
  atos_status: string | null = "Aberto",
) {
  return { ...slot(date, time), free: undefined, status, atos_status };
}

let calls: Call[] = [];
let answers: Array<{ status: number; body: unknown } | Error> = [];

const answer = (status: number, body: unknown) => answers.push({ status, body });
function problem(status: number, code: string) {
  answers.push({
    status,
    body: {
      type: `https://berseba.com.br/problems/${code}`,
      title: "x",
      status,
      detail: "x",
      instance: "/",
      code,
    },
  });
}

beforeEach(() => {
  calls = [];
  answers = [];
  tools.resetAtosSlotTakenForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL, init: RequestInit) => {
      calls.push({
        url: new URL(String(input)),
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const next = answers.shift();
      if (!next) throw new Error("no answer queued");
      if (next instanceof Error) throw next;
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A contacts table with one row; records the filters it was asked for. */
function fakeDb(phone: string | null) {
  const filters: Array<[string, unknown]> = [];
  const query = {
    select: () => query,
    eq: (col: string, val: unknown) => {
      filters.push([col, val]);
      return query;
    },
    maybeSingle: async () => {
      const ok =
        filters.some(([c, v]) => c === "organization_id" && v === ORG) &&
        filters.some(([c, v]) => c === "id" && v === CONTACT);
      return { data: ok ? { phone_number: phone } : null, error: null };
    },
  };
  return { supabase: { from: vi.fn(() => query) }, filters };
}

function ctx(over: Partial<Record<string, unknown>> = {}) {
  const { supabase, filters } = fakeDb(
    "phone" in over ? (over.phone as string | null) : CONTACT_PHONE,
  );
  return {
    filters,
    supabase,
    ctx: {
      organizationId: ORG,
      role: "ai_operator",
      actor: { type: "ai_agent", id: "ag-1", agent_id: "ag-1", role: "ai_operator" },
      apiTokenId: "tok-1",
      requestId: "req-1",
      sourceJobId: "job-1",
      contatoDoTurno: CONTACT,
      supabase,
      ...over,
    } as never,
  };
}

const run = (
  tool: { handler: (i: never, c: never) => Promise<unknown> },
  args: Args,
  c = ctx().ctx,
) => tool.handler(args as never, c) as Promise<Args>;

const atosTools = () => allTools.filter((t) => t.name.startsWith("atos_"));
const READS = ["atos_free_slots", "atos_my_classes"];
const WRITES = [
  "atos_cancel_class",
  "atos_reschedule_class",
  "atos_book_makeup",
  "atos_book_class",
  "atos_book_trial",
  "atos_create_recurring_plan",
];

describe("gates", () => {
  it("every tool refuses another organization without calling the API", async () => {
    for (const t of atosTools()) {
      const r = await run(t, {}, ctx({ organizationId: OTHER_ORG }).ctx);
      expect(r, t.name).toMatchObject({
        ok: false,
        permitido: false,
        code: "atos_indisponivel",
        handoff: false,
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("every tool refuses without a contact of the turn (HTTP route, external MCP)", async () => {
    for (const t of atosTools()) {
      const r = await run(t, {}, ctx({ contatoDoTurno: undefined }).ctx);
      expect(r, t.name).toMatchObject({ ok: false, code: "sem_contato_do_turno" });
    }
    expect(calls).toHaveLength(0);
  });

  it("my_classes hands off when the contact has no phone", async () => {
    const r = await run(tools.atosMyClasses, {}, ctx({ phone: null }).ctx);
    expect(r).toMatchObject({ ok: false, code: "contato_sem_telefone", handoff: true });
    expect(r.todo).toEqual(expect.any(String));
    expect(calls).toHaveLength(0);
  });

  it("takes the phone from the turn's contact, filtered by organization, never from the args", async () => {
    answer(200, { data: [] });
    const { ctx: c, filters } = ctx();
    await run(tools.atosMyClasses, { phone: "+5511000000000" }, c);
    expect(filters).toEqual([
      ["organization_id", ORG],
      ["id", CONTACT],
    ]);
    expect(calls[0]!.url.searchParams.get("phone")).toBe(PHONE);
  });

  it("free_slots never reads the contact nor sends a phone", async () => {
    answer(200, { data: [] });
    const { ctx: c, supabase } = ctx();
    await run(tools.atosFreeSlots, { phone: "+5511000000000" }, c);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(calls[0]!.url.searchParams.has("phone")).toBe(false);
  });

  it("no tool lets the model pass a phone; reads read and writes write", () => {
    for (const t of atosTools()) {
      expect(
        Object.keys(t.inputSchema).some((k) => /phone|telefone/i.test(k)),
        t.name,
      ).toBe(false);
      const isRead = READS.includes(t.name);
      expect(t.category, t.name).toBe(isRead ? "read" : "write");
      expect(t.requiresScope, t.name).toBe(isRead ? "mcp:read" : "mcp:write");
    }
  });
});

describe("atos_free_slots", () => {
  it("GET /v1/slots with the bearer key and only the parameters given", async () => {
    answer(200, { data: [slot("2026-11-13", "07:00")] });
    const r = await run(tools.atosFreeSlots, {
      from: "2026-11-13",
      plan: "totalpass_tp2",
      period: "manha",
    });
    const call = calls[0]!;
    expect(call.method).toBe("GET");
    expect(`${call.url.origin}${call.url.pathname}`).toBe(`${BASE}/v1/slots`);
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      from: "2026-11-13",
      plan: "totalpass_tp2",
      period: "manha",
    });
    expect(call.headers.Authorization).toBe("Bearer atos-test-key");
    expect(r).toMatchObject({
      ok: true,
      total: 1,
      aulas: [
        {
          slot_id: "2026-11-13-0700",
          dia_semana: "sexta-feira",
          data: "13/11",
          inicio: "07:00",
          fim: "07:40",
          vagas: 2,
        },
      ],
    });
    expect(r).not.toHaveProperty("mais_horarios");
  });

  it("no arguments = no query string (the API's default: today and tomorrow)", async () => {
    answer(200, { data: [] });
    const r = await run(tools.atosFreeSlots, {});
    expect(calls[0]!.url.search).toBe("");
    expect(r).toMatchObject({ ok: true, total: 0, aulas: [] });
    expect(tools.atosFreeSlots.motivoDoVazio?.(r)).toBe("sem_vagas");
  });

  it("returns at most 12 classes, the earliest first, and says there are more", async () => {
    const hours = ["19:00", "06:00", "18:00", "07:00", "17:00", "08:00", "16:00", "09:00"];
    const data = [
      ...hours.map((h) => slot("2026-11-16", h)),
      ...hours.map((h) => slot("2026-11-13", h)),
    ];
    answer(200, { data });
    const r = await run(tools.atosFreeSlots, { from: "2026-11-13", to: "2026-11-16" });
    const aulas = r.aulas as Array<{ data: string; inicio: string }>;
    expect(aulas).toHaveLength(tools.MAX_SLOTS);
    expect(aulas[0]).toMatchObject({ data: "13/11", inicio: "06:00" });
    expect(aulas[7]).toMatchObject({ data: "13/11", inicio: "19:00" });
    expect(aulas[8]).toMatchObject({ data: "16/11", inicio: "06:00" });
    expect(r).toMatchObject({ total: 16, mais_horarios: true });
  });

  it("never passes an instructor or an undeclared field to the model", async () => {
    answer(200, { data: [{ ...slot("2026-11-13", "07:00"), instructor: "Letícia" }] });
    const r = await run(tools.atosFreeSlots, {});
    expect(JSON.stringify(r)).not.toMatch(/Letícia|instructor|instrutora"/);
  });

  it("refuses a plan the API does not know (plain Silver) at the schema", async () => {
    const { z } = await import("zod");
    const schema = z.object(tools.atosFreeSlots.inputSchema);
    expect(schema.safeParse({ plan: "wellhub_silver" }).success).toBe(true);
    expect(schema.safeParse({ plan: "wellhub_basic" }).success).toBe(false);
    expect(schema.safeParse({ period: "noite" }).success).toBe(false);
    expect(schema.safeParse({ from: "13/11/2026" }).success).toBe(false);
  });

  it("catches a range the API would refuse, without handing off", async () => {
    let r = await run(tools.atosFreeSlots, { from: "2026-11-13", to: "2026-11-27" });
    expect(r).toMatchObject({ ok: false, code: "intervalo_longo", handoff: false });
    r = await run(tools.atosFreeSlots, { from: "2026-11-13", to: "2026-11-12" });
    expect(r).toMatchObject({ ok: false, code: "intervalo_invertido", handoff: false });
    expect(calls).toHaveLength(0);
    // 14 days inclusive is allowed.
    answer(200, { data: [] });
    r = await run(tools.atosFreeSlots, { from: "2026-11-13", to: "2026-11-26" });
    expect(r).toMatchObject({ ok: true });
  });

  it("measures a range with only `to` from today in Brasília", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-13T02:00:00Z")); // 12/11, 23h in Brasília
    expect(tools.todayInBrasilia()).toBe("2026-11-12");
    const r = await run(tools.atosFreeSlots, { to: "2026-11-26" });
    expect(r).toMatchObject({ code: "intervalo_longo" });
  });
});

describe("atos_my_classes", () => {
  it("GET /v1/bookings with the contact's phone and the dates given", async () => {
    answer(200, {
      data: [booking("2026-11-13", "07:00", "makeup", "Reposição"), booking("2026-11-12", "18:00")],
    });
    const r = await run(tools.atosMyClasses, { from: "2026-11-12", to: "2026-11-20" });
    const call = calls[0]!;
    expect(`${call.url.origin}${call.url.pathname}`).toBe(`${BASE}/v1/bookings`);
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      phone: PHONE,
      from: "2026-11-12",
      to: "2026-11-20",
    });
    expect(call.headers.Authorization).toBe("Bearer atos-test-key");
    expect(r).toEqual({
      ok: true,
      total: 2,
      aulas: [
        {
          booking_id: "2026-11-12-1800",
          dia_semana: "quinta-feira",
          data: "12/11",
          inicio: "18:00",
          fim: "18:40",
          status: "scheduled",
          status_atos: "Aberto",
        },
        {
          booking_id: "2026-11-13-0700",
          dia_semana: "sexta-feira",
          data: "13/11",
          inicio: "07:00",
          fim: "07:40",
          status: "makeup",
          status_atos: "Reposição",
        },
      ],
    });
  });

  it("a status this CRM does not know yet reads as unknown instead of failing", async () => {
    answer(200, { data: [booking("2026-11-13", "07:00", "on_hold", null)] });
    const r = await run(tools.atosMyClasses, {});
    expect(r).toMatchObject({ ok: true, aulas: [{ status: "unknown", status_atos: null }] });
  });

  it("an empty list is declared as such for the audit", async () => {
    answer(200, { data: [] });
    const r = await run(tools.atosMyClasses, {});
    expect(tools.atosMyClasses.motivoDoVazio?.(r)).toBe("sem_aulas");
  });
});

describe("errors", () => {
  const handoffCases: Array<[number, string]> = [
    [401, "unauthorized"],
    [422, "invalid_request"],
    [500, "internal_error"],
    [502, "atos_error"],
    [503, "atos_unavailable"],
    [503, "atos_login_failed"],
  ];

  for (const tool of ["atosFreeSlots", "atosMyClasses"] as const) {
    for (const [status, code] of handoffCases) {
      it(`${tool}: ${status} ${code} hands off`, async () => {
        problem(status, code);
        const r = await run(tools[tool], {});
        expect(r).toMatchObject({ ok: false, permitido: false, code, motivo: code, handoff: true });
        expect(r.mensagem).toMatch(/crm_request_human_handoff/);
        expect(r.todo).toEqual(expect.any(String));
      });
    }
  }

  it("my_classes: 404 student_not_found hands off with what the front desk must check", async () => {
    problem(404, "student_not_found");
    const r = await run(tools.atosMyClasses, {});
    expect(r).toMatchObject({ ok: false, code: "student_not_found", handoff: true });
    expect(r.todo).toMatch(/não está no Atos/);
  });

  it("my_classes: 409 ambiguous_student asks the name, then hands off", async () => {
    problem(409, "ambiguous_student");
    const r = await run(tools.atosMyClasses, {});
    expect(r).toMatchObject({ ok: false, code: "ambiguous_student", handoff: true });
    expect(r.mensagem).toMatch(/nome/);
    expect(r.mensagem).toMatch(/crm_request_human_handoff/);
  });

  it("no answer (timeout, network) hands off", async () => {
    const err = new Error("aborted");
    err.name = "TimeoutError";
    answers.push(err, new TypeError("fetch failed"));
    expect(await run(tools.atosFreeSlots, {})).toMatchObject({ code: "timeout", handoff: true });
    expect(await run(tools.atosMyClasses, {})).toMatchObject({
      code: "network_error",
      handoff: true,
    });
  });

  it("an error without Problem Details, or an unexpected body, hands off", async () => {
    answers.push({ status: 504, body: "<html>" });
    expect(await run(tools.atosFreeSlots, {})).toMatchObject({ code: "http_504", handoff: true });
    answer(200, { data: [{ id: "x" }] });
    expect(await run(tools.atosFreeSlots, {})).toMatchObject({
      code: "invalid_response",
      handoff: true,
    });
  });

  it("nothing of the student is logged", async () => {
    const { logger } = await import("@/lib/logger");
    const spies = (["info", "warn", "error"] as const).map((m) => vi.spyOn(logger, m));
    problem(409, "ambiguous_student");
    await run(tools.atosMyClasses, {});
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toMatch(/99999|5514999990001/);
    for (const s of spies) s.mockRestore();
  });
});

describe("audit", () => {
  it("keeps only the declared arguments, so a phone the model made up is never logged", () => {
    expect(
      tools.atosMyClasses.redigirParaAuditoria!({ from: "2026-11-13", phone: "+5514999990001" }),
    ).toEqual({ from: "2026-11-13" });
    expect(
      tools.atosFreeSlots.redigirParaAuditoria!({
        plan: "totalpass_tp3",
        period: "tarde",
        telefone: "14999990001",
      }),
    ).toEqual({ plan: "totalpass_tp3", period: "tarde" });
  });

  it("the result carries no phone", async () => {
    answer(200, { data: [booking("2026-11-13", "07:00")] });
    const r = await run(tools.atosMyClasses, {});
    expect(JSON.stringify(r)).not.toMatch(/99999|5514/);
  });
});

describe("registration", () => {
  const names = [...READS, ...WRITES];

  it("every Atos tool is in the handler index and the catalog, with the same category", () => {
    expect(
      atosTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual([...names].sort());
    expect(
      TOOL_CATALOG.filter((t) => t.name.startsWith("atos_"))
        .map((t) => t.name)
        .sort(),
    ).toEqual([...names].sort());
    for (const name of names) {
      const handler = allTools.find((t) => t.name === name);
      const entry = TOOL_CATALOG.find((t) => t.name === name);
      expect(entry?.category, name).toBe(handler?.category);
      expect(entry?.risco, name).toBe(READS.includes(name) ? "seguro" : "critico");
      expect(entry?.oQueToca, name).toBe("Agenda do estúdio (Atos)");
      expect(entry?.pacotes, name).toEqual(["atender"]);
    }
  });

  it("the agent turn offers them only to the enabled organization", () => {
    const build = (org: string) => {
      const actor = { type: "ai_agent", id: "ag-1", role: "ai_operator" };
      return pickToolsFromMcp({
        toolIds: names,
        auth: {
          organizationId: org,
          role: "ai_operator",
          scopes: ["mcp:read", "mcp:write"],
          actor,
          apiTokenId: "t",
        },
        ctx: {
          organizationId: org,
          role: "ai_operator",
          actor,
          apiTokenId: "t",
          requestId: "r",
          supabase: {},
        },
        supabase: {},
        pipelineIds: [],
        handoffToolEnabled: false,
        handoffSignal: { triggered: false },
      } as never);
    };
    expect(Object.keys(build(ORG)).sort()).toEqual([...names].sort());
    expect(Object.keys(build(OTHER_ORG))).toEqual([]);
  });
});

describe("writes", () => {
  const done = (extra = {}) =>
    answer(200, { booking: booking("2026-11-14", "18:00", "scheduled"), ...extra });

  const cases: Array<{
    tool: keyof typeof tools;
    args: Args;
    method: string;
    path: string;
    body: Record<string, unknown>;
  }> = [
    {
      tool: "atosCancelClass",
      args: { booking_id: "2026-11-13-0700", reason: "Viagem" },
      method: "POST",
      path: "/v1/bookings/2026-11-13-0700/cancel",
      body: { phone: PHONE, reason: "Viagem" },
    },
    {
      tool: "atosRescheduleClass",
      args: { booking_id: "2026-11-13-0700", slot_id: "2026-11-14-1800" },
      method: "POST",
      path: "/v1/bookings/2026-11-13-0700/reschedule",
      body: { phone: PHONE, slot_id: "2026-11-14-1800" },
    },
    {
      tool: "atosBookMakeup",
      args: { missed_booking_id: "2026-11-13-0700", slot_id: "2026-11-14-1800" },
      method: "POST",
      path: "/v1/makeups",
      body: { phone: PHONE, missed_booking_id: "2026-11-13-0700", slot_id: "2026-11-14-1800" },
    },
    {
      tool: "atosBookClass",
      args: { slot_id: "2026-11-14-1800" },
      method: "POST",
      path: "/v1/bookings",
      body: { phone: PHONE, slot_id: "2026-11-14-1800" },
    },
    {
      tool: "atosBookTrial",
      args: {
        name: "Marina Souza",
        birth_date: "1990-05-20",
        slot_id: "2026-11-14-1800",
        pregnant: true,
        needs: "Dor lombar",
      },
      method: "POST",
      path: "/v1/trial-bookings",
      body: {
        phone: PHONE,
        name: "Marina Souza",
        birth_date: "1990-05-20",
        slot_id: "2026-11-14-1800",
        pregnant: true,
        needs: "Dor lombar",
      },
    },
    {
      tool: "atosCreateRecurringPlan",
      args: {
        name: "Marina Souza",
        birth_date: "1990-05-20",
        plan: "totalpass_tp3",
        weekly: [
          { weekday: "monday", start_time: "07:00" },
          { weekday: "wednesday", start_time: "07:00" },
        ],
      },
      method: "POST",
      path: "/v1/recurring-plans",
      body: {
        phone: PHONE,
        name: "Marina Souza",
        birth_date: "1990-05-20",
        plan: "totalpass_tp3",
        weekly: [
          { weekday: "monday", start_time: "07:00" },
          { weekday: "wednesday", start_time: "07:00" },
        ],
      },
    },
  ];

  const tool = (name: keyof typeof tools) =>
    tools[name] as unknown as { name: string; handler: (i: never, c: never) => Promise<unknown> };

  for (const c of cases) {
    it(`${c.tool}: ${c.method} ${c.path} with the contact's phone, the key and the args`, async () => {
      done();
      const r = await run(tool(c.tool), { ...c.args, phone: "+5511000000000" });
      const call = calls[0]!;
      expect(call.method).toBe(c.method);
      expect(`${call.url.origin}${call.url.pathname}`).toBe(`${BASE}${c.path}`);
      expect(call.body).toEqual(c.body);
      expect(call.headers.Authorization).toBe("Bearer atos-test-key");
      expect(call.headers["Idempotency-Key"]).toMatch(/^atos:job-1:atos_[a-z_]+:[0-9a-f]{16}$/);
      expect(r).toMatchObject({
        ok: true,
        aula: {
          booking_id: "2026-11-14-1800",
          dia_semana: "sábado",
          data: "14/11",
          inicio: "18:00",
        },
      });
    });
  }

  it("the key is stable for the same write and changes with the args or the job", () => {
    const k = (job: string, args: Args, name = "atos_book_class") =>
      tools.atosIdempotencyKey({ sourceJobId: job } as never, name, args);
    expect(k("j", { slot_id: "a" })).toBe(k("j", { slot_id: "a" }));
    expect(k("j", { slot_id: "a" })).not.toBe(k("j", { slot_id: "b" }));
    expect(k("j", { slot_id: "a" })).not.toBe(k("j2", { slot_id: "a" }));
    expect(k("j", { slot_id: "a" })).not.toBe(k("j", { slot_id: "a" }, "atos_book_trial"));
    expect(tools.atosIdempotencyKey({} as never, "atos_book_class", {})).toBeNull();
  });

  it("without a job there is no key, and nothing is written", async () => {
    const r = await run(
      tools.atosBookClass,
      { slot_id: "2026-11-14-1800" },
      ctx({ sourceJobId: undefined }).ctx,
    );
    expect(r).toMatchObject({ ok: false, code: "sem_chave_de_idempotencia", handoff: true });
    expect(calls).toHaveLength(0);
  });

  it("every write refuses another organization, no conversation and no phone, without calling", async () => {
    for (const c of cases) {
      expect(
        await run(tool(c.tool), c.args, ctx({ organizationId: OTHER_ORG }).ctx),
        c.tool,
      ).toMatchObject({
        code: "atos_indisponivel",
      });
      expect(
        await run(tool(c.tool), c.args, ctx({ contatoDoTurno: undefined }).ctx),
        c.tool,
      ).toMatchObject({
        code: "sem_contato_do_turno",
      });
      expect(await run(tool(c.tool), c.args, ctx({ phone: null }).ctx), c.tool).toMatchObject({
        code: "contato_sem_telefone",
        handoff: true,
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("cancel says whether the class earns a make-up", async () => {
    answer(200, {
      booking: booking("2026-11-13", "07:00", "cancelled", "Desmarcado"),
      makeup_eligible: true,
    });
    const r = await run(tools.atosCancelClass, { booking_id: "2026-11-13-0700" });
    expect(r).toMatchObject({ ok: true, tem_reposicao: true, aula: { status: "cancelled" } });
    expect(calls[0]!.body).toEqual({ phone: PHONE });
  });

  it("a 2xx with an unexpected body still counts as done", async () => {
    answer(201, { something: "else" });
    expect(await run(tools.atosBookClass, { slot_id: "2026-11-14-1800" })).toMatchObject({
      ok: true,
    });
    answer(200, null);
    expect(await run(tools.atosBookClass, { slot_id: "2026-11-14-1801" })).toMatchObject({
      ok: true,
    });
  });

  it("ids must have the Atos shape", async () => {
    const { z } = await import("zod");
    const schema = z.object(tools.atosRescheduleClass.inputSchema);
    expect(
      schema.safeParse({ booking_id: "2026-11-13-0700", slot_id: "2026-11-14-1800" }).success,
    ).toBe(true);
    expect(schema.safeParse({ booking_id: "../admin", slot_id: "2026-11-14-1800" }).success).toBe(
      false,
    );
    expect(schema.safeParse({ booking_id: "2026-11-13-0700", slot_id: "sexta 7h" }).success).toBe(
      false,
    );
  });

  it("409 slot_unavailable: search again once, then hand off", async () => {
    problem(409, "slot_unavailable");
    let r = await run(tools.atosBookClass, { slot_id: "2026-11-14-1800" });
    expect(r).toMatchObject({ ok: false, code: "slot_unavailable", handoff: false });
    expect(r.mensagem).toMatch(/atos_free_slots/);
    problem(409, "slot_unavailable");
    r = await run(tools.atosBookClass, { slot_id: "2026-11-14-1900" });
    expect(r).toMatchObject({ ok: false, code: "slot_unavailable", handoff: true });
  });

  it("422 rule_violation: repeat the studio's detail and do not hand off", async () => {
    answers.push({
      status: 422,
      body: {
        type: "x",
        title: "x",
        status: 422,
        detail: "A reposição vale por um mês depois da aula desmarcada.",
        instance: "/v1/makeups",
        code: "rule_violation",
      },
    });
    const r = await run(tools.atosBookMakeup, {
      missed_booking_id: "2026-10-01-0700",
      slot_id: "2026-11-14-1800",
    });
    expect(r).toMatchObject({
      ok: false,
      permitido: false,
      code: "rule_violation",
      handoff: false,
      detail: "A reposição vale por um mês depois da aula desmarcada.",
    });
    expect(r).not.toHaveProperty("todo");
  });

  const handoffs: Array<[number, string]> = [
    [404, "student_not_found"],
    [404, "not_found"],
    [409, "ambiguous_student"],
    [501, "not_enabled"],
    [503, "atos_unavailable"],
    [500, "internal_error"],
  ];
  for (const [status, code] of handoffs) {
    it(`${status} ${code} hands off`, async () => {
      problem(status, code);
      const r = await run(tools.atosRescheduleClass, {
        booking_id: "2026-11-13-0700",
        slot_id: "2026-11-14-1800",
      });
      expect(r).toMatchObject({ ok: false, code, handoff: true });
      expect(r.todo).toEqual(expect.any(String));
    });
  }

  it("502 atos_write_unconfirmed: never repeat, the front desk checks", async () => {
    problem(502, "atos_write_unconfirmed");
    const r = await run(tools.atosBookTrial, cases[4]!.args);
    expect(r).toMatchObject({ ok: false, code: "atos_write_unconfirmed", handoff: true });
    expect(r.mensagem).toMatch(/NUNCA repita/);
    expect(r.todo).toMatch(/Conferir no Atos/);
    expect(calls).toHaveLength(1);
  });

  it("no answer to a write is unconfirmed too, and is not retried", async () => {
    const err = new Error("aborted");
    err.name = "TimeoutError";
    answers.push(err);
    const r = await run(tools.atosCancelClass, { booking_id: "2026-11-13-0700" });
    expect(r).toMatchObject({ ok: false, code: "timeout", handoff: true });
    expect(r.todo).toMatch(/Conferir no Atos/);
    expect(calls).toHaveLength(1);
  });

  it("the trial's personal data and every free text stay out of the audit", () => {
    expect(
      tools.atosBookTrial.redigirParaAuditoria!({ ...cases[4]!.args, phone: "+5514" }),
    ).toEqual({
      name: "[redacted]",
      birth_date: "[redacted]",
      slot_id: "2026-11-14-1800",
      pregnant: "[redacted]",
      needs: "[redacted]",
    });
    expect(
      tools.atosCancelClass.redigirParaAuditoria!({
        booking_id: "2026-11-13-0700",
        reason: "Gripe",
      }),
    ).toEqual({ booking_id: "2026-11-13-0700", reason: "[redacted]" });
  });

  it("recurring plan: at most 2 days for TP2+ and Wellhub, 3 for TP3, checked before calling", async () => {
    const three = [
      { weekday: "monday", start_time: "07:00" },
      { weekday: "wednesday", start_time: "07:00" },
      { weekday: "friday", start_time: "07:00" },
    ];
    const base = { name: "Marina Souza", birth_date: "1990-05-20", weekly: three };
    for (const plan of ["totalpass_tp2", "wellhub_silver"]) {
      expect(await run(tools.atosCreateRecurringPlan, { ...base, plan }), plan).toMatchObject({
        code: "dias_demais",
        handoff: false,
      });
    }
    expect(calls).toHaveLength(0);
    done();
    expect(
      await run(tools.atosCreateRecurringPlan, { ...base, plan: "totalpass_tp3", months: 6 }),
    ).toMatchObject({ ok: true });
    expect(calls[0]!.body).toMatchObject({ plan: "totalpass_tp3", months: 6 });
  });

  it("book_class sends name, birth date and plan only when given", async () => {
    done();
    await run(tools.atosBookClass, {
      slot_id: "2026-11-14-1800",
      name: "Marina Souza",
      birth_date: "1990-05-20",
      plan: "wellhub_silver",
    });
    expect(calls[0]!.body).toEqual({
      phone: PHONE,
      slot_id: "2026-11-14-1800",
      name: "Marina Souza",
      birth_date: "1990-05-20",
      plan: "wellhub_silver",
    });
  });

  it("recurring plan returns the classes booked and whether the student was registered", async () => {
    answer(200, {
      bookings: [booking("2026-11-16", "07:00"), booking("2026-11-18", "07:00")],
      student_created: true,
    });
    const r = await run(tools.atosCreateRecurringPlan, {
      name: "Marina Souza",
      birth_date: "1990-05-20",
      plan: "wellhub_silver",
      weekly: [
        { weekday: "monday", start_time: "07:00" },
        { weekday: "wednesday", start_time: "07:00" },
      ],
    });
    expect(r).toMatchObject({
      ok: true,
      cadastro_novo: true,
      aulas: [
        { booking_id: "2026-11-16-0700", dia_semana: "segunda-feira" },
        { booking_id: "2026-11-18-0700", dia_semana: "quarta-feira" },
      ],
    });
  });

  it("cancel is about one class, never the plan", () => {
    expect(tools.atosCancelClass.description).toMatch(/nunca o plano/);
    expect(tools.atosCancelClass.description).toMatch(/handoff/);
  });

  it("every write is declared in both write-scope tables", () => {
    for (const name of WRITES) {
      expect(ESCOPO_DAS_ESCRITAS[name], name).toBeDefined();
      expect(ALVO_DE_FUNIL[name], name).toBe("sem_funil");
    }
  });

  it("every write asks the agent to confirm day and time first", () => {
    for (const name of WRITES) {
      expect(allTools.find((t) => t.name === name)?.description, name).toMatch(
        /Confirma (sexta|segunda)/,
      );
    }
  });
});
