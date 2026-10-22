/**
 * Berseba: the avec agenda tools (salon Mayara Morales). `fetch` is mocked: no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const CONTACT_PHONE = "+55 (14) 99999-0001";
const API = "http://mayara-avec-api:8000";

vi.mock("@/lib/integrations/avec/config", () => {
  const config = {
    baseUrl: "http://mayara-avec-api:8000",
    apiKey: "test-key",
    orgIds: new Set([ORG]),
  };
  return {
    AVEC_TOOL_PREFIX: "avec_",
    avecConfigFor: (org: string) => (org === ORG ? config : null),
    isAvecToolHiddenFor: (name: string, org: string) => name.startsWith("avec_") && org !== ORG,
  };
});
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn().mockResolvedValue(undefined) }));

const tools = await import("./avec");
const { allTools } = await import("./index");
const { TOOL_CATALOG } = await import("./catalog");
const { ESCOPO_DAS_ESCRITAS } = await import("@/lib/ai/runtime/escopo-das-escritas");
const { ALVO_DE_FUNIL } = await import("@/lib/leads/escopo-de-funil");
const { pickToolsFromMcp } = await import("@/lib/ai/runtime/tools");

type Args = Record<string, unknown>;
type Call = { url: URL; method: string; headers: Record<string, string>; body: unknown };

const APPOINTMENT = {
  id: "88123-901-430008-2026-10-23",
  client_name: "Ana Teste",
  client_phone: "(14) 99999-0001",
  service_id: "901",
  service: "Corte",
  professional_id: "430008",
  professional: "Beca",
  date: "2026-10-23",
  start_time: "10:00",
  end_time: "11:00",
  starts_at: "2026-10-23T10:00:00-03:00",
  status: "1",
};

let calls: Call[] = [];
let answers: Array<{ status: number; body: unknown } | Error> = [];

function answer(status: number, body: unknown) {
  answers.push({ status, body });
}
function problem(status: number, code: string) {
  answer(status, { type: `https://berseba.com.br/problems/${code}`, status, code, detail: "x" });
}

beforeEach(() => {
  calls = [];
  answers = [];
  tools.resetAvecSlotTakenForTests();
  tools.resetAvecProfessionalsCacheForTests();
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
afterEach(() => vi.unstubAllGlobals());

/** A contacts table with one row; records the filters it was asked for. */
function fakeDb(phone: string | null = CONTACT_PHONE) {
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
  const { supabase, filters } = fakeDb(over.phone as string | null | undefined);
  return {
    filters,
    ctx: {
      organizationId: ORG,
      role: "ai_operator",
      actor: { type: "ai_agent", id: "ag-1", role: "ai_operator" },
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

describe("gates", () => {
  it("refuses another organization without calling the API", async () => {
    const r = await run(tools.avecMyAppointments, {}, ctx({ organizationId: OTHER_ORG }).ctx);
    expect(r).toMatchObject({ ok: false, motivo: "avec_indisponivel" });
    expect(calls).toHaveLength(0);
  });

  it("refuses without a contact of the turn (HTTP route, external MCP)", async () => {
    const r = await run(tools.avecMyAppointments, {}, ctx({ contatoDoTurno: undefined }).ctx);
    expect(r).toMatchObject({ ok: false, motivo: "sem_contato_do_turno" });
    expect(calls).toHaveLength(0);
  });

  it("hands off when the contact has no phone", async () => {
    const r = await run(tools.avecMyAppointments, {}, ctx({ phone: null }).ctx);
    expect(r).toMatchObject({ ok: false, motivo: "contato_sem_telefone", handoff: true });
    expect(calls).toHaveLength(0);
  });

  it("takes the phone from the turn's contact, filtered by organization, never from the args", async () => {
    answer(200, { data: [] });
    const { ctx: c, filters } = ctx();
    await run(tools.avecMyAppointments, { phone: "+5511000000000" }, c);
    expect(filters).toEqual([
      ["organization_id", ORG],
      ["id", CONTACT],
    ]);
    expect(calls[0]!.url.searchParams.get("phone")).toBe("+5514999990001");
  });

  it("no tool lets the model pass a phone", () => {
    for (const t of allTools.filter((t) => t.name.startsWith("avec_"))) {
      expect(Object.keys(t.inputSchema).some((k) => /phone|telefone/i.test(k))).toBe(false);
    }
  });
});

describe("request shape", () => {
  it("avec_my_appointments", async () => {
    answer(200, { data: [APPOINTMENT] });
    const r = await run(tools.avecMyAppointments, { from: "2026-10-23", to: "2026-10-30" });
    const call = calls[0]!;
    expect(call.method).toBe("GET");
    expect(`${call.url.origin}${call.url.pathname}`).toBe(`${API}/v1/appointments`);
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      phone: "+5514999990001",
      from: "2026-10-23",
      to: "2026-10-30",
    });
    expect(call.headers.Authorization).toBe("Bearer test-key");
    expect(call.headers["Idempotency-Key"]).toBeUndefined();
    expect(r).toMatchObject({ ok: true, total: 1 });
    // No client name or phone reaches the model or the audit log.
    expect(JSON.stringify(r)).not.toMatch(/Ana Teste|99999-0001|client_/);
  });

  it("avec_find_services matches name without case or accent, and caps the list", async () => {
    answer(200, {
      data: [
        {
          id: "430008",
          name: "Beca",
          services: [
            { id: "901", name: "Corte Feminino", duration_minutes: 60, price: "120,00" },
            { id: "902", name: "Sobrancelha", duration_minutes: 30, price: "40,00" },
          ],
        },
        {
          id: "430009",
          name: "Mayara",
          services: Array.from({ length: 20 }, (_, i) => ({
            id: `9${i}`,
            name: `CORTE Ãpice ${i}`,
            duration_minutes: 45,
            price: "0,00",
          })),
        },
      ],
    });
    const r = await run(tools.avecFindServices, { search: "corte" });
    expect(calls[0]!.url.pathname).toBe("/v1/professionals");
    expect(r.total_encontrado).toBe(21);
    expect((r.servicos as unknown[]).length).toBe(15);
    expect(JSON.stringify(r)).not.toContain("price");

    const accent = await run(tools.avecFindServices, { search: "apice 13" });
    expect(accent.servicos).toEqual([
      {
        service_id: "913",
        service: "CORTE Ãpice 13",
        professional_id: "430009",
        professional: "Mayara",
        duration_minutes: 45,
      },
    ]);
    expect(calls).toHaveLength(1); // the catalog is cached
    expect(tools.avecFindServices.motivoDoVazio!({ ok: true, total_encontrado: 0 })).toBe(
      "servico_nao_encontrado",
    );
  });

  it("avec_free_slots sorts earliest first and caps at 12", async () => {
    const slot = (day: number, hour: number) => ({
      id: `430008-901-2026-10-${day}-${hour}00`,
      professional_id: "430008",
      service_id: "901",
      date: `2026-10-${day}`,
      start_time: `${hour}:00`,
      end_time: `${hour + 1}:00`,
      starts_at: `2026-10-${day}T${hour}:00:00-03:00`,
    });
    answer(200, {
      data: [slot(24, 10), ...Array.from({ length: 13 }, (_, i) => slot(23, 9 + (i % 9)))],
    });
    const r = await run(tools.avecFreeSlots, { service_id: "901", professional_id: "430008" });
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      service_id: "901",
      professional_id: "430008",
    });
    const slots = r.horarios as Array<{ slot_id: string; date: string }>;
    expect(slots).toHaveLength(12);
    expect(slots.every((s) => s.date === "2026-10-23")).toBe(true);
    expect(r.total_encontrado).toBe(14);
  });

  it("avec_cancel", async () => {
    answer(200, { id: APPOINTMENT.id, status: "cancelled" });
    const r = await run(tools.avecCancel, {
      appointment_id: APPOINTMENT.id,
      reason: "Ficou doente",
    });
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.pathname).toBe(`/v1/appointments/${APPOINTMENT.id}/cancel`);
    expect(call.body).toEqual({ phone: "+5514999990001", reason: "Ficou doente" });
    expect(call.headers["Idempotency-Key"]).toMatch(/^avec:job-1:avec_cancel:[0-9a-f]{16}$/);
    expect(r).toEqual({ ok: true, appointment_id: APPOINTMENT.id, status: "cancelled" });
  });

  it("avec_reschedule returns the new appointment id", async () => {
    answer(200, { ...APPOINTMENT, id: "88123-901-430008-2026-10-24", date: "2026-10-24" });
    const r = await run(tools.avecReschedule, {
      appointment_id: APPOINTMENT.id,
      slot_id: "430008-901-2026-10-24-1000",
    });
    expect(calls[0]!.url.pathname).toBe(`/v1/appointments/${APPOINTMENT.id}/reschedule`);
    expect(calls[0]!.body).toEqual({
      phone: "+5514999990001",
      slot_id: "430008-901-2026-10-24-1000",
    });
    expect(r).toMatchObject({
      ok: true,
      agendamento: { appointment_id: "88123-901-430008-2026-10-24" },
    });
  });

  it("avec_book", async () => {
    answer(201, APPOINTMENT);
    const r = await run(tools.avecBook, { slot_id: "430008-901-2026-10-23-1000" });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/v1/appointments");
    expect(calls[0]!.body).toEqual({
      phone: "+5514999990001",
      slot_id: "430008-901-2026-10-23-1000",
    });
    expect(r).toMatchObject({ ok: true, agendamento: { appointment_id: APPOINTMENT.id } });
  });
});

describe("errors → handoff", () => {
  const cases: Array<[number, string, boolean]> = [
    [401, "unauthorized", true],
    [404, "not_found", false],
    [409, "ambiguous_appointment", true],
    [409, "ambiguous_client", true],
    [409, "idempotency_in_flight", false],
    [422, "not_allowed", true],
    [422, "client_not_found", true],
    [422, "invalid_request", true],
    [422, "idempotency_key_reused", true],
    [501, "not_implemented", true],
    [502, "avec_error", true],
    [502, "avec_write_unconfirmed", true],
    [503, "avec_unavailable", true],
    [503, "avec_session_expired", true],
    [500, "internal_error", true],
  ];
  it.each(cases)("%i %s → handoff %s", async (status, code, handoff) => {
    problem(status, code);
    const r = await run(tools.avecReschedule, { appointment_id: APPOINTMENT.id, slot_id: "s-1" });
    expect(r).toMatchObject({ ok: false, code, handoff });
    if (handoff) expect(r.todo).toEqual(expect.any(String));
  });

  it("a body without a Problem code still hands off", async () => {
    answer(500, "oops");
    expect(await run(tools.avecMyAppointments, {})).toMatchObject({
      ok: false,
      code: "http_500",
      handoff: true,
    });
  });

  it("a write without an HTTP answer is unconfirmed: never retried, hand off", async () => {
    const err = new Error("aborted");
    err.name = "TimeoutError";
    answers.push(err);
    const r = await run(tools.avecCancel, { appointment_id: APPOINTMENT.id });
    expect(r).toMatchObject({ ok: false, code: "timeout", handoff: true });
    expect(r.todo).toMatch(/Conferir no avec/);
  });

  it("the first slot_unavailable asks for new slots, the second hands off", async () => {
    problem(409, "slot_unavailable");
    problem(409, "slot_unavailable");
    const first = await run(tools.avecReschedule, {
      appointment_id: APPOINTMENT.id,
      slot_id: "s-1",
    });
    const second = await run(tools.avecReschedule, {
      appointment_id: APPOINTMENT.id,
      slot_id: "s-2",
    });
    expect(first).toMatchObject({ code: "slot_unavailable", handoff: false });
    expect(second).toMatchObject({ code: "slot_unavailable", handoff: true });
  });

  it("an unexpected response body hands off", async () => {
    answer(200, { data: [{ id: 1 }] });
    expect(await run(tools.avecMyAppointments, {})).toMatchObject({
      code: "invalid_response",
      handoff: true,
    });
  });
});

describe("idempotency", () => {
  it("is stable for the same job and body, and changes with the slot", () => {
    const c = ctx().ctx;
    const a = tools.avecIdempotencyKey(c, "avec_reschedule", {
      appointment_id: "a",
      slot_id: "s-1",
    });
    expect(
      tools.avecIdempotencyKey(c, "avec_reschedule", { appointment_id: "a", slot_id: "s-1" }),
    ).toBe(a);
    expect(
      tools.avecIdempotencyKey(c, "avec_reschedule", { appointment_id: "a", slot_id: "s-2" }),
    ).not.toBe(a);
    expect(a!.length).toBeGreaterThanOrEqual(8);
    expect(a!.length).toBeLessThanOrEqual(128);
  });

  it("a write without a job refuses instead of risking a double write", async () => {
    const r = await run(
      tools.avecCancel,
      { appointment_id: "a" },
      ctx({ sourceJobId: undefined }).ctx,
    );
    expect(r).toMatchObject({ ok: false, motivo: "sem_chave_de_idempotencia", handoff: true });
    expect(calls).toHaveLength(0);
  });
});

describe("audit", () => {
  it("keeps the client's free text out of api_audit_log", () => {
    expect(
      tools.avecCancel.redigirParaAuditoria!({ appointment_id: "a", reason: "Ficou doente" }),
    ).toEqual({
      appointment_id: "a",
      reason: "[redacted]",
    });
    expect(tools.avecBook.redigirParaAuditoria!({ slot_id: "s", note: "alergia" })).toEqual({
      slot_id: "s",
      note: "[redacted]",
    });
  });
});

describe("registration", () => {
  const names = [
    "avec_my_appointments",
    "avec_find_services",
    "avec_free_slots",
    "avec_book",
    "avec_reschedule",
    "avec_cancel",
  ];

  it("every avec tool is in the handler index and the catalog, with the same category", () => {
    for (const name of names) {
      const handler = allTools.find((t) => t.name === name);
      const entry = TOOL_CATALOG.find((t) => t.name === name);
      expect(handler, name).toBeDefined();
      expect(entry?.category, name).toBe(handler?.category);
    }
  });

  it("the writes are declared in both write-scope tables and never enter by bundle", () => {
    for (const name of ["avec_book", "avec_reschedule", "avec_cancel"]) {
      expect(ESCOPO_DAS_ESCRITAS[name], name).toBeDefined();
      expect(ALVO_DE_FUNIL[name], name).toBe("sem_funil");
      expect(TOOL_CATALOG.find((t) => t.name === name)?.risco, name).toBe("critico");
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
