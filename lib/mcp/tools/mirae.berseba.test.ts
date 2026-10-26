/**
 * Berseba: the Mirae agenda tools (Fiore Pilates). `fetch` is mocked: no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const CONTACT_PHONE = "+55 (14) 99999-0001";
const PHONE = "5514999990001";
const BASE = "https://mirae.example/api/v1/orgs/fiore";

const { moveCard, captureMessage } = vi.hoisted(() => ({
  moveCard: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("@/lib/integrations/mirae/config", () => {
  const config = {
    orgUrl: "https://mirae.example/api/v1/orgs/fiore",
    apiKey: "mirae_sk_test",
    orgIds: new Set([ORG]),
  };
  return {
    MIRAE_TOOL_PREFIX: "mirae_",
    miraeConfigFor: (org: string) => (org === ORG ? config : null),
    isMiraeToolHiddenFor: (name: string, org: string) => name.startsWith("mirae_") && org !== ORG,
  };
});
vi.mock("@/lib/integrations/mirae/evaluation-stage", () => ({
  moveCardOnEvaluationBooked: moveCard,
}));
vi.mock("@sentry/nextjs", () => ({ captureMessage }));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn().mockResolvedValue(undefined) }));

const tools = await import("./mirae");
const { miraeConfigFor } = await import("@/lib/integrations/mirae/config");
const { allTools } = await import("./index");
const { TOOL_CATALOG } = await import("./catalog");
const { ESCOPO_DAS_ESCRITAS } = await import("@/lib/ai/runtime/escopo-das-escritas");
const { ALVO_DE_FUNIL } = await import("@/lib/leads/escopo-de-funil");
const { pickToolsFromMcp } = await import("@/lib/ai/runtime/tools");

const CONFIG = miraeConfigFor(ORG)!;

type Args = Record<string, unknown>;
type Call = { url: URL; method: string; headers: Record<string, string>; body: unknown };

const RAQUEL = { id: "grKtqvJUMbrjUuR46eH88Srx7CFGMBBa", first_name: "Raquel" };
const ANDRESSA = { id: "ZuljZLbCzFCn_Kim_nYh0", first_name: "Andressa" };

/** A free slot as `GET /availability` answers it. */
function slot(date: string, time: string, professional = RAQUEL, extra = {}) {
  const [h] = time.split(":");
  return {
    starts_at: `${date}T${time}:00-03:00`,
    ends_at: `${date}T${h}:50:00-03:00`,
    date,
    time,
    weekday: "terça-feira",
    professional,
    ...extra,
  };
}

const APPOINTMENT = {
  id: "8ClDgOSe2sTXOwZA2O8tM",
  service: "evaluation",
  ...slot("2026-10-29", "14:00"),
  weekday: "quinta-feira",
  status: "scheduled",
  can_change: true,
};

const EVALUATION_OPCAO = tools.encodeOpcao(CONFIG, {
  s: "evaluation",
  t: "2026-10-27T15:00:00-03:00",
  p: RAQUEL.id,
});

let calls: Call[] = [];
let answers: Array<{ status: number; body: unknown } | Error> = [];

function answer(status: number, body: unknown) {
  answers.push({ status, body });
}
function problem(status: number, code: string, extra = {}) {
  answers.push({
    status,
    body: {
      type: `urn:mirae:problem:${code}`,
      title: "x",
      status,
      detail: "x",
      instance: "/",
      code,
      ...extra,
    },
  });
}
function noAnswer() {
  const err = new Error("aborted");
  err.name = "TimeoutError";
  answers.push(err);
}

beforeEach(() => {
  calls = [];
  answers = [];
  moveCard.mockReset().mockResolvedValue({ harness: "advanced", card: "movido" });
  captureMessage.mockReset();
  tools.resetMiraeSlotTakenForTests();
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
function fakeDb(phone: string | null, name: string | null) {
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
      return { data: ok ? { phone_number: phone, name } : null, error: null };
    },
  };
  return { supabase: { from: vi.fn(() => query) }, filters };
}

function ctx(over: Partial<Record<string, unknown>> = {}) {
  const { supabase, filters } = fakeDb(
    "phone" in over ? (over.phone as string | null) : CONTACT_PHONE,
    "name" in over ? (over.name as string | null) : "Marina Souza",
  );
  return {
    filters,
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

describe("gates", () => {
  it("refuses another organization without calling the API", async () => {
    const r = await run(tools.miraeMyAppointments, {}, ctx({ organizationId: OTHER_ORG }).ctx);
    expect(r).toMatchObject({ ok: false, motivo: "mirae_indisponivel", handoff: false });
    expect(calls).toHaveLength(0);
  });

  it("every tool refuses without the install config", async () => {
    for (const t of allTools.filter((t) => t.name.startsWith("mirae_"))) {
      const r = await run(
        t,
        { opcao_id: EVALUATION_OPCAO, appointment_id: "a", servico: "aula" },
        ctx({ organizationId: OTHER_ORG }).ctx,
      );
      expect(r, t.name).toMatchObject({ ok: false, motivo: "mirae_indisponivel" });
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses without a contact of the turn (HTTP route, external MCP)", async () => {
    const r = await run(tools.miraeMyAppointments, {}, ctx({ contatoDoTurno: undefined }).ctx);
    expect(r).toMatchObject({ ok: false, motivo: "sem_contato_do_turno" });
    expect(calls).toHaveLength(0);
  });

  it("hands off when the contact has no phone", async () => {
    const r = await run(tools.miraeMyAppointments, {}, ctx({ phone: null }).ctx);
    expect(r).toMatchObject({ ok: false, motivo: "contato_sem_telefone", handoff: true });
    expect(calls).toHaveLength(0);
  });

  it("takes the phone from the turn's contact, filtered by organization, digits only, never from the args", async () => {
    answer(200, { person: null, data: [] });
    const { ctx: c, filters } = ctx();
    await run(tools.miraeMyAppointments, { phone: "5511000000000" }, c);
    expect(filters).toEqual([
      ["organization_id", ORG],
      ["id", CONTACT],
    ]);
    expect(calls[0]!.url.searchParams.get("phone")).toBe(PHONE);
  });

  it("no tool lets the model pass a phone", () => {
    for (const t of allTools.filter((t) => t.name.startsWith("mirae_"))) {
      expect(
        Object.keys(t.inputSchema).some((k) => /phone|telefone/i.test(k)),
        t.name,
      ).toBe(false);
    }
  });
});

describe("client", () => {
  it("GET with the bearer key, no idempotency key, and no empty query", async () => {
    answer(200, { person: { first_name: "Marina", stage: "lead" }, data: [APPOINTMENT] });
    const r = await run(tools.miraeMyAppointments, { from: "2026-10-25" });
    const call = calls[0]!;
    expect(call.method).toBe("GET");
    expect(`${call.url.origin}${call.url.pathname}`).toBe(`${BASE}/appointments`);
    expect(Object.fromEntries(call.url.searchParams)).toEqual({ phone: PHONE, from: "2026-10-25" });
    expect(call.headers.Authorization).toBe("Bearer mirae_sk_test");
    expect(call.headers["Idempotency-Key"]).toBeUndefined();
    expect(r).toEqual({
      ok: true,
      pessoa: { primeiro_nome: "Marina", etapa: "lead" },
      agendamentos: [
        {
          appointment_id: APPOINTMENT.id,
          servico: "avaliação inicial",
          dia_semana: "quinta-feira",
          data: "2026-10-29",
          data_br: "29/10",
          inicio: "14:00",
          termina: "14:50",
          profissional: "Raquel",
          status: "scheduled",
          pode_mudar: true,
        },
      ],
    });
  });

  it("a problem+json without a code still hands off, as http_<status>", async () => {
    answer(502, "bad gateway");
    expect(await run(tools.miraeMyAppointments, {})).toMatchObject({
      ok: false,
      code: "http_502",
      handoff: true,
    });
  });

  it("a read without an answer hands off with code timeout", async () => {
    noAnswer();
    expect(await run(tools.miraeMyAppointments, {})).toMatchObject({
      code: "timeout",
      handoff: true,
    });
    expect(calls).toHaveLength(1); // reads are not retried by the tool
  });

  it("an unexpected 2xx body is invalid_response: hand off and alert", async () => {
    answer(200, { data: [{ id: 1 }] });
    const r = await run(tools.miraeMyAppointments, {});
    expect(r).toMatchObject({ code: "invalid_response", handoff: true });
    expect(r.todo).toMatch(/Falha na integração com o Mirae \(invalid_response\)/);
    await vi.waitFor(() => expect(captureMessage).toHaveBeenCalled());
  });
});

describe("mirae_services", () => {
  it("relays the plans the studio offers, with the monthly value, and the studio's rules", async () => {
    answer(200, {
      data: [
        {
          id: "p1",
          name: "Trimestral 2x",
          cadence: "quarterly",
          months: 3,
          price_cents: 105000,
          currency: "BRL",
          sessions_per_week: 2,
          total_sessions: 24,
        },
        {
          id: "p2",
          name: "Avulsa",
          cadence: "single",
          months: null,
          price_cents: 9000,
          currency: "BRL",
          sessions_per_week: 1,
          total_sessions: 1,
        },
      ],
    });
    answer(200, {
      time_zone: "America/Sao_Paulo",
      min_notice_hours: 12,
      horizon_days: 14,
      cancellation_min_hours: 4,
    });
    const r = await run(tools.miraeServices, {});
    expect(calls.map((c) => c.url.pathname.split("/").at(-1))).toEqual(["plans", "booking-rules"]);
    expect(r).toEqual({
      ok: true,
      servicos: ["avaliacao", "aula"],
      planos: [
        {
          nome: "Trimestral 2x",
          valor_br: "R$ 1.050,00",
          meses: 3,
          por_mes_br: "R$ 350,00",
          aulas_por_semana: 2,
        },
        { nome: "Avulsa", valor_br: "R$ 90,00", aulas_por_semana: 1 },
      ],
      regras: {
        antecedencia_minima_horas: 12,
        agenda_aberta_dias: 14,
        remarcar_ou_cancelar_ate_horas_antes: 4,
      },
      com_a_equipe: expect.arrayContaining(["massagem", "fisioterapia"]),
    });
  });

  it("the plans survive a failure to read the rules", async () => {
    answer(200, { data: [] });
    problem(500, "internal_error");
    const r = await run(tools.miraeServices, {});
    expect(r).toMatchObject({ ok: true, planos: [] });
    expect(r).not.toHaveProperty("regras");
  });
});

describe("mirae_free_slots", () => {
  it("evaluation: day and period go to Mirae, the phone does not, and at most 2 options come back as they came", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-25T15:00:00Z"));
    answer(200, {
      service: "evaluation",
      duration_minutes: 50,
      data: [
        slot("2026-10-27", "15:00"),
        slot("2026-10-28", "14:00", ANDRESSA),
        slot("2026-10-29", "13:00"),
      ],
    });
    const r = await run(tools.miraeFreeSlots, {
      servico: "avaliação",
      data: "2026-10-27",
      periodo: "tarde",
    });
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      service: "evaluation",
      date: "2026-10-27",
      period: "afternoon",
    });
    const opcoes = r.opcoes as Array<Record<string, unknown>>;
    expect(opcoes).toHaveLength(tools.MIRAE_MAX_OPCOES);
    expect(opcoes[0]).toMatchObject({
      dia_semana: "terça-feira",
      data: "2026-10-27",
      data_br: "27/10",
      inicio: "15:00",
      termina: "15:50",
      profissional: "Raquel",
    });
    expect(opcoes.map((o) => o.profissional)).toEqual(["Raquel", "Andressa"]);
    expect(tools.decodeOpcao(CONFIG, String(opcoes[0]!.opcao_id))).toEqual({
      s: "evaluation",
      t: "2026-10-27T15:00:00-03:00",
      p: RAQUEL.id,
    });
  });

  it("class: Mirae gets the phone (classes are for the studio's people) and the spots left come back", async () => {
    answer(200, {
      service: "class",
      duration_minutes: 50,
      data: [slot("2026-10-27", "16:00", RAQUEL, { spots_left: 3 })],
    });
    const r = await run(tools.miraeFreeSlots, { servico: "aula", periodo: "noite" });
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      service: "class",
      period: "evening",
      phone: PHONE,
    });
    expect((r.opcoes as Args[])[0]).toMatchObject({ vagas: 3 });
  });

  it("another service (massagem, fisioterapia) hands off without calling the API", async () => {
    const r = await run(tools.miraeFreeSlots, { servico: "massagem" });
    expect(r).toMatchObject({ ok: false, motivo: "servico_com_a_equipe", handoff: true });
    expect(r.todo).toBe("Quer massagem; a API não marca.");
    expect(calls).toHaveLength(0);
  });

  it("an empty list hands off with the day and period asked, never 'no slots'", async () => {
    answer(200, { service: "evaluation", duration_minutes: 50, data: [] });
    const r = await run(tools.miraeFreeSlots, {
      servico: "avaliacao",
      data: "2099-11-03",
      periodo: "manha",
    });
    expect(r).toMatchObject({ ok: false, motivo: "sem_horario", handoff: true });
    expect(r.todo).toBe("Quer avaliação inicial (03/11, manhã); sem horário na API.");
  });

  it("a past date is sent back to the agent", async () => {
    const r = await run(tools.miraeFreeSlots, { servico: "avaliacao", data: "2020-01-01" });
    expect(r).toMatchObject({ ok: false, handoff: false });
    expect(calls).toHaveLength(0);
  });

  it("for a reschedule: the service of the appointment, and options tied to it", async () => {
    answer(200, { person: { first_name: "Marina", stage: "lead" }, data: [APPOINTMENT] });
    answer(200, {
      service: "evaluation",
      duration_minutes: 50,
      data: [slot("2026-10-30", "09:00")],
    });
    const r = await run(tools.miraeFreeSlots, {
      servico: "aula",
      remarcar_appointment_id: APPOINTMENT.id,
    });
    expect(calls[1]!.url.searchParams.get("service")).toBe("evaluation");
    const opcao = tools.decodeOpcao(CONFIG, String((r.opcoes as Args[])[0]!.opcao_id));
    expect(opcao).toMatchObject({ s: "evaluation", r: APPOINTMENT.id });
  });

  it("for a reschedule past the studio's deadline: hand off with the deadline from Mirae", async () => {
    answer(200, { person: null, data: [{ ...APPOINTMENT, can_change: false }] });
    answer(200, {
      time_zone: "America/Sao_Paulo",
      min_notice_hours: 12,
      horizon_days: 14,
      cancellation_min_hours: 4,
    });
    answer(200, { person: null, data: [{ ...APPOINTMENT, can_change: false }] });
    const r = await run(tools.miraeFreeSlots, {
      servico: "avaliacao",
      remarcar_appointment_id: APPOINTMENT.id,
    });
    expect(r).toMatchObject({ code: "too_late", handoff: true });
    expect(r.todo).toBe("Quer remarcar avaliação inicial de 29/10 às 14:00; faltam menos de 4 h.");
  });

  it("a clinical appointment is not rescheduled through the API", async () => {
    answer(200, { person: null, data: [{ ...APPOINTMENT, service: "other" }] });
    const r = await run(tools.miraeFreeSlots, {
      servico: "avaliacao",
      remarcar_appointment_id: APPOINTMENT.id,
    });
    expect(r).toMatchObject({ code: "service_not_supported", handoff: true });
  });

  it("person_not_found on a class offers the evaluation", async () => {
    problem(422, "person_not_found");
    const r = await run(tools.miraeFreeSlots, { servico: "aula" });
    expect(r).toMatchObject({ code: "person_not_found", handoff: false });
    expect(r.mensagem).toMatch(/avaliação inicial/);
  });
});

describe("mirae_book", () => {
  it("posts the decoded option with the contact's phone and name, under a stable key", async () => {
    answer(201, {
      ...APPOINTMENT,
      ...slot("2026-10-27", "15:00"),
      status: "scheduled",
      can_change: true,
    });
    const r = await run(tools.miraeBook, { opcao_id: EVALUATION_OPCAO });
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.toString()).toBe(`${BASE}/appointments`);
    expect(call.body).toEqual({
      service: "evaluation",
      starts_at: "2026-10-27T15:00:00-03:00",
      professional_id: RAQUEL.id,
      phone: PHONE,
      name: "Marina Souza",
    });
    expect(call.headers["Idempotency-Key"]).toMatch(/^mirae:job-1:mirae_book:[0-9a-f]{16}$/);
    expect(r).toEqual({
      ok: true,
      agendamento: {
        appointment_id: APPOINTMENT.id,
        servico: "avaliação inicial",
        dia_semana: "terça-feira",
        data_br: "27/10",
        inicio: "15:00",
        termina: "15:50",
        profissional: "Raquel",
      },
    });
  });

  it("an evaluation moves the card, a class does not", async () => {
    answer(201, APPOINTMENT);
    await run(tools.miraeBook, { opcao_id: EVALUATION_OPCAO });
    expect(moveCard).toHaveBeenCalledTimes(1);
    moveCard.mockClear();
    answer(201, { ...APPOINTMENT, service: "class" });
    await run(tools.miraeBook, {
      opcao_id: tools.encodeOpcao(CONFIG, {
        s: "class",
        t: "2026-10-27T16:00:00-03:00",
        p: RAQUEL.id,
      }),
    });
    expect(moveCard).not.toHaveBeenCalled();
  });

  it("a failed booking does not move the card", async () => {
    problem(409, "is_student");
    await run(tools.miraeBook, { opcao_id: EVALUATION_OPCAO });
    expect(moveCard).not.toHaveBeenCalled();
  });

  it("says when Mirae booked another professional at the same time", async () => {
    answer(201, { ...APPOINTMENT, professional: ANDRESSA });
    const r = await run(tools.miraeBook, { opcao_id: EVALUATION_OPCAO });
    expect(r).toMatchObject({ ok: true, agendamento: { profissional: "Andressa" } });
    expect(r.aviso).toMatch(/profissional mudou/);
  });

  it("refuses an edited, forged or foreign opcao_id before any call", async () => {
    const [payload, mac] = EVALUATION_OPCAO.split(".");
    const later = Buffer.from(
      JSON.stringify({ s: "evaluation", t: "2026-10-27T07:00:00-03:00", p: RAQUEL.id }),
    ).toString("base64url");
    const forged = [
      `${later}.${mac}`, // another time, same signature
      `${payload}.${mac!.slice(0, -1)}A`, // edited signature
      `${payload}`, // no signature
      "evaluation:2026-10-27T15:00:00-03:00:grKtqvJUMbrjUuR46eH88Srx7CFGMBBa", // made up
      tools.encodeOpcao(
        { ...CONFIG, apiKey: "another" },
        { s: "evaluation", t: "2026-10-27T15:00:00-03:00" },
      ),
    ];
    for (const opcao_id of forged) {
      expect(await run(tools.miraeBook, { opcao_id }), opcao_id).toMatchObject({
        ok: false,
        handoff: false,
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("keeps ids with '-' and '_' whole", () => {
    const id = "a-b_c-d_e";
    const opcao = tools.encodeOpcao(CONFIG, {
      s: "class",
      t: "2026-10-27T16:00:00-03:00",
      p: id,
      r: "x_y-z",
    });
    expect(tools.decodeOpcao(CONFIG, opcao)).toEqual({
      s: "class",
      t: "2026-10-27T16:00:00-03:00",
      p: id,
      r: "x_y-z",
    });
  });

  it("an option minted for a reschedule is not booked", async () => {
    const opcao_id = tools.encodeOpcao(CONFIG, {
      s: "evaluation",
      t: "2026-10-30T09:00:00-03:00",
      r: APPOINTMENT.id,
    });
    expect(await run(tools.miraeBook, { opcao_id })).toMatchObject({ ok: false, handoff: false });
    expect(calls).toHaveLength(0);
  });

  it("without a name for the person, asks for it", async () => {
    const r = await run(tools.miraeBook, { opcao_id: EVALUATION_OPCAO }, ctx({ name: null }).ctx);
    expect(r).toMatchObject({ ok: false, handoff: false });
    expect(calls).toHaveLength(0);
  });
});

describe("writes without an answer", () => {
  it("retry once with the SAME key, and succeed", async () => {
    noAnswer();
    answer(201, APPOINTMENT);
    const r = await run(tools.miraeBook, { opcao_id: EVALUATION_OPCAO });
    expect(r).toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers["Idempotency-Key"]).toBe(calls[0]!.headers["Idempotency-Key"]);
  });

  it.each([
    ["no answer twice", () => (noAnswer(), noAnswer())],
    ["5xx twice", () => (problem(500, "internal_error"), problem(503, "internal_error"))],
  ])("%s: hand off to check Mirae, never a third call", async (_label, queue) => {
    queue();
    const r = await run(tools.miraeCancel, { appointment_id: APPOINTMENT.id });
    expect(r).toMatchObject({ ok: false, handoff: true });
    expect(r.todo).toMatch(/Conferir no Mirae/);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers["Idempotency-Key"]).toBe(calls[0]!.headers["Idempotency-Key"]);
  });

  it("a 4xx is never retried", async () => {
    problem(409, "is_student");
    await run(tools.miraeBook, { opcao_id: EVALUATION_OPCAO });
    expect(calls).toHaveLength(1);
  });
});

describe("each code of the contract", () => {
  const cases: Array<[number, string, boolean, RegExp | null]> = [
    [401, "unauthorized", true, /Falha na integração com o Mirae \(unauthorized\)/],
    [403, "organization_not_allowed", true, /Falha na integração/],
    [403, "insufficient_scope", true, /Falha na integração/],
    [403, "product_disabled", true, /Falha na integração/],
    [404, "not_found", false, null],
    [409, "slot_unavailable", false, null],
    [409, "already_booked", false, null],
    [409, "is_student", true, /^Aluna pedindo avaliação\/reavaliação\.$/],
    [409, "ambiguous_person", false, null],
    [409, "no_balance", true, /^Quer aula; sem plano ativo com aula sobrando\.$/],
    [409, "not_changeable", false, null],
    [422, "invalid_request", true, /Falha na integração/],
    [422, "service_not_supported", true, /a API não marca/],
    [422, "person_not_found", false, null],
    [422, "idempotency_key_reused", true, /Falha na integração/],
  ];
  it.each(cases)("%i %s → handoff %s", async (status, code, handoff, todo) => {
    problem(status, code);
    const r = await run(tools.miraeBook, { opcao_id: EVALUATION_OPCAO });
    expect(r).toMatchObject({ ok: false, code, handoff });
    if (todo) expect(r.todo).toMatch(todo);
    if (!handoff) expect(r).not.toHaveProperty("todo");
  });

  it("the integration codes alert Sentry, the business ones do not", async () => {
    problem(401, "unauthorized");
    await run(tools.miraeBook, { opcao_id: EVALUATION_OPCAO });
    await vi.waitFor(() => expect(captureMessage).toHaveBeenCalledTimes(1));
    expect(captureMessage.mock.calls[0]![0]).toMatch(/unauthorized/);
    captureMessage.mockClear();
    problem(409, "no_balance");
    await run(tools.miraeBook, { opcao_id: EVALUATION_OPCAO });
    await new Promise((r) => setTimeout(r, 10));
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("the first slot_unavailable asks for new slots, the second (same contact, 30 min) hands off", async () => {
    problem(409, "slot_unavailable");
    problem(409, "slot_unavailable");
    const first = await run(tools.miraeBook, { opcao_id: EVALUATION_OPCAO });
    const second = await run(tools.miraeBook, { opcao_id: EVALUATION_OPCAO });
    expect(first).toMatchObject({ code: "slot_unavailable", handoff: false });
    expect(first.mensagem).toMatch(/mirae_free_slots/);
    expect(second).toMatchObject({
      code: "slot_unavailable",
      handoff: true,
      todo: "Horários mudando; marcar à mão.",
    });
  });

  it("already_booked tells when, and offers to reschedule", async () => {
    problem(409, "already_booked", { starts_at: "2026-10-29T14:00:00-03:00" });
    const r = await run(tools.miraeBook, { opcao_id: EVALUATION_OPCAO });
    expect(r.mensagem).toMatch(/29\/10 às 14:00/);
    expect(r.mensagem).toMatch(/remarcar/);
  });

  it("ambiguous_person asks the full name, and with it tries again by name", async () => {
    problem(409, "ambiguous_person");
    const ask = await run(tools.miraeBook, { opcao_id: EVALUATION_OPCAO });
    expect(ask).toMatchObject({ handoff: false });
    expect(ask.mensagem).toMatch(/nome completo/);
    answer(201, APPOINTMENT);
    await run(tools.miraeBook, { opcao_id: EVALUATION_OPCAO, nome_completo: "Marina Souza Lima" });
    expect((calls[1]!.body as Args).name).toBe("Marina Souza Lima");
    expect(calls[1]!.headers["Idempotency-Key"]).not.toBe(calls[0]!.headers["Idempotency-Key"]);
    problem(409, "ambiguous_person");
    expect(
      await run(tools.miraeBook, {
        opcao_id: EVALUATION_OPCAO,
        nome_completo: "Marina Souza Lima",
      }),
    ).toMatchObject({ handoff: true });
  });

  it("ambiguous_person on GET /appointments asks the name, then sends it", async () => {
    problem(409, "ambiguous_person");
    expect(await run(tools.miraeMyAppointments, {})).toMatchObject({ handoff: false });
    answer(200, { person: null, data: [] });
    await run(tools.miraeMyAppointments, { nome_completo: "Marina Souza" });
    expect(calls[1]!.url.searchParams.get("name")).toBe("Marina Souza");
  });

  it("too_late on cancel names the appointment and the studio's deadline", async () => {
    problem(409, "too_late");
    answer(200, {
      time_zone: "America/Sao_Paulo",
      min_notice_hours: 12,
      horizon_days: 14,
      cancellation_min_hours: 4,
    });
    answer(200, { person: null, data: [APPOINTMENT] });
    const r = await run(tools.miraeCancel, { appointment_id: APPOINTMENT.id });
    expect(r).toMatchObject({ code: "too_late", handoff: true });
    expect(r.todo).toBe("Quer cancelar avaliação inicial de 29/10 às 14:00; faltam menos de 4 h.");
  });
});

describe("mirae_reschedule and mirae_cancel", () => {
  const RESCHEDULE_OPCAO = tools.encodeOpcao(CONFIG, {
    s: "evaluation",
    t: "2026-10-30T09:00:00-03:00",
    p: ANDRESSA.id,
    r: APPOINTMENT.id,
  });

  it("reschedules with the option found for that appointment, and warns that the id may change", async () => {
    answer(200, { ...APPOINTMENT, id: "new-id", ...slot("2026-10-30", "09:00", ANDRESSA) });
    const r = await run(tools.miraeReschedule, {
      appointment_id: APPOINTMENT.id,
      opcao_id: RESCHEDULE_OPCAO,
    });
    expect(calls[0]!.url.toString()).toBe(`${BASE}/appointments/${APPOINTMENT.id}/reschedule`);
    expect(calls[0]!.body).toEqual({
      starts_at: "2026-10-30T09:00:00-03:00",
      professional_id: ANDRESSA.id,
      phone: PHONE,
    });
    expect(calls[0]!.headers["Idempotency-Key"]).toMatch(/^mirae:job-1:mirae_reschedule:/);
    expect(r).toMatchObject({
      ok: true,
      agendamento: { appointment_id: "new-id", profissional: "Andressa" },
    });
    expect(r.aviso).toMatch(/appointment_id pode ter mudado/);
    expect(moveCard).not.toHaveBeenCalled();
  });

  it("refuses an option found for another appointment, or for a new booking", async () => {
    for (const opcao_id of [RESCHEDULE_OPCAO, EVALUATION_OPCAO]) {
      const r = await run(tools.miraeReschedule, { appointment_id: "another", opcao_id });
      expect(r).toMatchObject({ ok: false, handoff: false });
    }
    expect(calls).toHaveLength(0);
  });

  it("cancels with the phone only: no reason in free text", async () => {
    answer(200, { id: APPOINTMENT.id, status: "cancelled" });
    const r = await run(tools.miraeCancel, { appointment_id: APPOINTMENT.id });
    expect(calls[0]!.url.toString()).toBe(`${BASE}/appointments/${APPOINTMENT.id}/cancel`);
    expect(calls[0]!.body).toEqual({ phone: PHONE });
    expect(r).toEqual({ ok: true, appointment_id: APPOINTMENT.id, status: "cancelled" });
    expect(Object.keys(tools.miraeCancel.inputSchema)).not.toContain("reason");
    expect(moveCard).not.toHaveBeenCalled();
  });
});

describe("idempotency", () => {
  it("is stable for the same job and body, changes with the body, and fits 8–128", () => {
    const c = ctx().ctx;
    const a = tools.miraeIdempotencyKey(c, "mirae_cancel", { appointmentId: "a" });
    expect(tools.miraeIdempotencyKey(c, "mirae_cancel", { appointmentId: "a" })).toBe(a);
    expect(tools.miraeIdempotencyKey(c, "mirae_cancel", { appointmentId: "b" })).not.toBe(a);
    expect(a).toMatch(/^[!-~]{8,128}$/);
    const long = tools.miraeIdempotencyKey(
      ctx({ sourceJobId: "j".repeat(200) }).ctx,
      "mirae_book",
      {},
    );
    expect(long!.length).toBe(128);
  });

  it("a write without a job refuses instead of risking a double write", async () => {
    for (const [tool, args] of [
      [tools.miraeBook, { opcao_id: EVALUATION_OPCAO }],
      [tools.miraeCancel, { appointment_id: "a" }],
    ] as const) {
      const r = await run(tool, args, ctx({ sourceJobId: undefined }).ctx);
      expect(r).toMatchObject({ ok: false, motivo: "sem_chave_de_idempotencia", handoff: true });
    }
    expect(calls).toHaveLength(0);
  });
});

describe("privacy", () => {
  it("keeps the client's name out of api_audit_log", () => {
    expect(
      tools.miraeBook.redigirParaAuditoria!({ opcao_id: "o", nome_completo: "Marina Souza" }),
    ).toEqual({ opcao_id: "o", nome_completo: "[redacted]" });
  });

  it("never returns the client's phone or full name to the model", async () => {
    answer(201, APPOINTMENT);
    const r = await run(tools.miraeBook, { opcao_id: EVALUATION_OPCAO });
    expect(JSON.stringify(r)).not.toMatch(/Souza|99999|5514/);
  });

  it("never logs the phone", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    for (const s of spies) s.mockImplementation(() => {});
    problem(409, "no_balance");
    await run(tools.miraeBook, { opcao_id: EVALUATION_OPCAO });
    const logged = spies.flatMap((s) => s.mock.calls.flat()).join("\n");
    expect(logged).not.toMatch(/99999|5514999990001/);
    for (const s of spies) s.mockRestore();
  });
});

describe("registration", () => {
  const names = [
    "mirae_my_appointments",
    "mirae_services",
    "mirae_free_slots",
    "mirae_book",
    "mirae_reschedule",
    "mirae_cancel",
  ];

  it("every Mirae tool is in the handler index and the catalog, with the same category", () => {
    expect(
      allTools
        .filter((t) => t.name.startsWith("mirae_"))
        .map((t) => t.name)
        .sort(),
    ).toEqual([...names].sort());
    for (const name of names) {
      const handler = allTools.find((t) => t.name === name);
      const entry = TOOL_CATALOG.find((t) => t.name === name);
      expect(handler, name).toBeDefined();
      expect(entry?.category, name).toBe(handler?.category);
      expect(entry?.oQueToca, name).toBe("Agenda do estúdio (Mirae)");
      expect(entry?.pacotes, name).toEqual(["atender"]);
    }
  });

  it("reads are seguro; writes are critico and declared in both write-scope tables", () => {
    for (const name of ["mirae_my_appointments", "mirae_services", "mirae_free_slots"]) {
      expect(TOOL_CATALOG.find((t) => t.name === name)?.risco, name).toBe("seguro");
    }
    for (const name of ["mirae_book", "mirae_reschedule", "mirae_cancel"]) {
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
