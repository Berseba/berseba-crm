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

type Args = Record<string, unknown>;
type Call = { url: URL; method: string; headers: Record<string, string> };

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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL, init: RequestInit) => {
      calls.push({
        url: new URL(String(input)),
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string>,
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

  it("no tool lets the model pass a phone, and no tool writes", () => {
    for (const t of atosTools()) {
      expect(
        Object.keys(t.inputSchema).some((k) => /phone|telefone/i.test(k)),
        t.name,
      ).toBe(false);
      expect(t.category, t.name).toBe("read");
      expect(t.requiresScope, t.name).toBe("mcp:read");
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
        { dia_semana: "sexta-feira", data: "13/11", inicio: "07:00", fim: "07:40", vagas: 2 },
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
          dia_semana: "quinta-feira",
          data: "12/11",
          inicio: "18:00",
          fim: "18:40",
          status: "scheduled",
          status_atos: "Aberto",
        },
        {
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
  const names = ["atos_free_slots", "atos_my_classes"];

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
      expect(entry?.risco, name).toBe("seguro");
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
          scopes: ["mcp:read"],
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
