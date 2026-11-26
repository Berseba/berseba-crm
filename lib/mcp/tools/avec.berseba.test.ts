/**
 * Berseba: the avec agenda tools (salon Mayara Morales). `fetch` is mocked: no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Ofertas from "@/lib/integrations/avec/ofertas";

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
vi.mock("@/lib/integrations/avec/ofertas", async (importOriginal) => {
  const actual = await importOriginal<typeof Ofertas>();
  const mayara = actual.salaoDa("e054ee97-00a7-42fd-9701-279afc04a74c");
  return { ...actual, salaoDa: (org: string) => (org === ORG ? mayara : null) };
});
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn().mockResolvedValue(undefined) }));
// The waitlist reads Supabase through `fetch`, which this file counts as avec calls.
vi.mock("@/lib/integrations/avec/lista-de-espera-supabase", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ocupacoesSeguradasPorOutras: vi.fn().mockResolvedValue([]),
  configDaEsperaAvec: vi.fn().mockResolvedValue(null),
  dispararBuscaDaEspera: vi.fn(),
  encerrarAoMarcar: vi.fn().mockResolvedValue(undefined),
}));

const tools = await import("./avec");
const { allTools } = await import("./index");
const { TOOL_CATALOG } = await import("./catalog");
const { ESCOPO_DAS_ESCRITAS } = await import("@/lib/ai/runtime/escopo-das-escritas");
const { ALVO_DE_FUNIL } = await import("@/lib/leads/escopo-de-funil");
const { pickToolsFromMcp } = await import("@/lib/ai/runtime/tools");

type Args = Record<string, unknown>;
type Call = { url: URL; method: string; headers: Record<string, string>; body: unknown };

// A design de sobrancelha with Rebeca: one service that day, so the agent may change it alone.
const APPOINTMENT = {
  id: "88123-2129417-447142-2026-10-23",
  client_name: "Ana Teste",
  client_phone: "(14) 99999-0001",
  service_id: "2129417",
  service: "Sobrancelha",
  professional_id: "447142",
  professional: "Rebeca Cardoso",
  date: "2026-10-23",
  start_time: "10:00",
  end_time: "10:30",
  starts_at: "2026-10-23T10:00:00-03:00",
  status: "1",
};

/** A free slot as `GET /v1/availability` answers it. */
function slot(
  prof: string,
  service: string,
  date: string,
  start: string,
  minutes = 30,
  facts = {},
) {
  const [h, m] = start.split(":").map(Number) as [number, number];
  const end = h * 60 + m + minutes;
  const hhmm = `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
  return {
    id: `${prof}-${service}-${date}-${start.replace(":", "")}`,
    professional_id: prof,
    service_id: service,
    date,
    start_time: start,
    end_time: hhmm,
    starts_at: `${date}T${start}:00-03:00`,
    bookings_that_day: 3,
    gap_before_minutes: 0,
    gap_after_minutes: null,
    ...facts,
  };
}

/** The two reads every change of an appointment starts with: the appointment, then its day. */
function sameDay(...extra: Array<typeof APPOINTMENT>) {
  answer(200, APPOINTMENT);
  answer(200, { data: [APPOINTMENT, ...extra] });
}

/** `avec_my_appointments` reads 60 days in 14-day windows: answers the 4 windows after the first. */
function restOfWindows() {
  for (let i = 0; i < 4; i++) answer(200, { data: [] });
}

const SOBRANCELHA_OPCAO = "sobrancelha_design:-:447142-2129417-2026-10-27-1000";

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
      return { data: ok ? { phone_number: phone, name: "Ana Teste" } : null, error: null };
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
    restOfWindows();
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
    expect((r.agendamentos as unknown[])[0]).toMatchObject({ status: "1", can_change: true });
    // No client name or phone reaches the model or the audit log.
    expect(JSON.stringify(r)).not.toMatch(/Ana Teste|99999-0001|client_/);
  });

  it("avec_find_services lists the salon's ofertas, who does each, and what stays with the team", async () => {
    const r = await run(tools.avecFindServices, {});
    expect(calls).toHaveLength(0); // the menu is the salon's, not avec's catalog
    const servicos = r.servicos as Array<{ servico: string; profissionais: string[] }>;
    expect(servicos.find((o) => o.servico === "sobrancelha_design")?.profissionais).toEqual([
      "Rebeca",
    ]);
    expect(servicos.find((o) => o.servico === "tintura_raiz")?.profissionais).not.toContain(
      "Júlia",
    );
    expect(servicos.some((o) => /mecha/i.test(o.servico))).toBe(false);
    expect(r.com_a_equipe).toEqual(expect.arrayContaining(["mechas", "maquiagem"]));
  });

  it("avec_free_slots joins the recipe's steps and offers up to 2 options with day, time and professional", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T15:00:00Z"));
    // Corte feminino com secagem, cabelo médio, with Mayara: corte + lavagem (helper) at +0,
    // secagem with the SAME helper at +30. Júlia is free for the lavagem but not the secagem
    // at 14:00, so Júnior takes that visit.
    answer(200, {
      data: [
        slot("430008", "2128712", "2026-10-27", "09:00", 30, {
          gap_before_minutes: null,
          gap_after_minutes: 120,
          bookings_that_day: 1,
        }),
        slot("430008", "2128712", "2026-10-27", "14:00"),
        slot("430008", "2128712", "2026-10-30", "10:00"),
      ],
    });
    answer(200, {
      data: [
        slot("797917", "2128749", "2026-10-27", "09:00"),
        slot("797917", "2128749", "2026-10-27", "14:00"),
        slot("444091", "2128749", "2026-10-27", "14:00"),
        slot("797917", "2128749", "2026-10-30", "10:00"),
      ],
    });
    answer(200, {
      data: [
        slot("797917", "2129312", "2026-10-27", "09:30"),
        slot("444091", "2129312", "2026-10-27", "14:30"),
        slot("797917", "2129312", "2026-10-30", "10:30"),
      ],
    });
    const r = await run(tools.avecFreeSlots, {
      servico: "corte_feminino_com_secagem",
      comprimento: "medio",
      profissional: "Mayara",
    });
    expect(calls.map((c) => c.url.searchParams.get("service_id"))).toEqual([
      "2128712",
      "2128749",
      "2129312",
    ]);
    expect(calls[0]!.url.searchParams.get("professional_id")).toBe("430008");
    expect(calls[1]!.url.searchParams.get("professional_id")).toBeNull();
    expect(calls[0]!.url.searchParams.get("from")).toBe("2026-10-23");
    expect(calls[0]!.url.searchParams.get("to")).toBe("2026-11-05");
    const opcoes = r.opcoes as Array<Record<string, unknown>>;
    // At most 2. This week first: 27/10 14:00 is next to her clients, 27/10 09:00 is a day she
    // works but far from them (gap 120); 30/10 is next week (today is 23/10), so it is left out.
    expect(opcoes.map((o) => [o.data_br, o.inicio, o.agrupado])).toEqual([
      ["27/10", "14:00", true],
      ["27/10", "09:00", false],
    ]);
    expect(opcoes[0]).toMatchObject({
      dia_semana: "terça-feira",
      profissional: "Mayara Morales",
      tambem: "lavagem às 14:00 e secagem às 14:30",
      tambem_com: "Júnior",
      termina_por_volta_de: "15:00",
      agrupado: true,
      opcao_id:
        "corte_feminino_com_secagem:medio:430008-2128712-2026-10-27-1400+444091-2128749-2026-10-27-1400+444091-2129312-2026-10-27-1430",
    });
  });

  it("avec_free_slots keeps to the helper the client asked for", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T15:00:00Z"));
    answer(200, { data: [slot("430008", "2128712", "2026-10-27", "14:00")] });
    answer(200, {
      data: [
        slot("797917", "2128749", "2026-10-27", "14:00"),
        slot("444099", "2128749", "2026-10-27", "14:00"),
      ],
    });
    answer(200, {
      data: [
        slot("797917", "2129312", "2026-10-27", "14:30"),
        slot("444099", "2129312", "2026-10-27", "14:30"),
      ],
    });
    const r = await run(tools.avecFreeSlots, {
      servico: "corte_feminino_com_secagem",
      comprimento: "medio",
      profissional: "Mayara",
      auxiliar: "simone",
    });
    expect(calls[1]!.url.searchParams.get("professional_id")).toBe("444099");
    expect((r.opcoes as Array<{ tambem_com: string }>)[0]!.tambem_com).toBe("Simone");
    const ninguem = await run(tools.avecFreeSlots, {
      servico: "corte_feminino_com_secagem",
      comprimento: "medio",
      auxiliar: "Rebeca",
    });
    expect(String(ninguem.mensagem)).toMatch(/Júlia, Júnior, Simone, Giovanna, Suellen/);
  });

  it("progressiva on a Saturday goes to the team, and Saturdays are never offered for it", async () => {
    const sabado = await run(tools.avecFreeSlots, {
      servico: "progressiva",
      comprimento: "medio",
      dias_semana: ["sabado"],
    });
    expect(sabado).toMatchObject({ ok: false, handoff: true, motivo: "sabado_com_a_equipe" });
    expect(String(sabado.mensagem)).toMatch(/nunca diga que não há horário/);
    expect(calls).toHaveLength(0);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T15:00:00Z"));
    answer(200, {
      data: [
        slot("444091", "2128737", "2026-10-24", "09:00", 120),
        slot("444091", "2128737", "2026-10-27", "09:00", 120),
      ],
    });
    const r = await run(tools.avecFreeSlots, { servico: "progressiva", comprimento: "medio" });
    expect((r.opcoes as Array<{ data: string }>).map((o) => o.data)).toEqual(["2026-10-27"]);
  });

  it("no slot the salon would offer hands off to a person, never 'no slots'", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T15:00:00Z"));
    answer(200, { data: [] });
    const r = await run(tools.avecFreeSlots, {
      servico: "sobrancelha_design",
      dias_semana: ["sexta"],
      periodo: "tarde",
    });
    expect(r).toMatchObject({ ok: false, handoff: true, motivo: "sem_horario" });
    expect(String(r.mensagem)).toMatch(/Não diga que não há horário/);
    expect(String(r.todo)).toMatch(/Design de sobrancelha .*\(sexta, tarde\)/);
  });

  it("with the waitlist on, no slot offers the list before calling the team", async () => {
    const espera = await import("@/lib/integrations/avec/lista-de-espera-supabase");
    vi.mocked(espera.configDaEsperaAvec).mockResolvedValueOnce({
      ativa: true,
      prazo_maximo_minutos: 120,
      margem_antes_minutos: 180,
      prazo_minimo_minutos: 30,
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T15:00:00Z"));
    answer(200, { data: [] });
    const r = await run(tools.avecFreeSlots, { servico: "sobrancelha_design", dias_semana: ["sexta"] });
    expect(r).toMatchObject({ ok: false, handoff: false, motivo: "sem_horario", lista_de_espera: true });
    expect(String(r.mensagem)).toMatch(/avec_waitlist/);
    expect(String(r.todo)).toMatch(/Design de sobrancelha/);
  });

  it("the waitlist tool answers 'off' when the organization did not turn it on", async () => {
    const r = await run(tools.avecWaitlist, { acao: "entrar", servico: "escova", data_de: "2026-12-15" });
    expect(r).toMatchObject({ ok: false, handoff: false, motivo: "lista_desligada" });
    expect(calls).toHaveLength(0);
  });

  it("avec_free_slots asks for the hair length, and refuses an unknown service", async () => {
    const semComprimento = await run(tools.avecFreeSlots, { servico: "escova" });
    expect(semComprimento).toMatchObject({ ok: false, handoff: false });
    expect(String(semComprimento.mensagem)).toMatch(/comprimento/);
    const mechas = await run(tools.avecFreeSlots, { servico: "mechas" });
    expect(mechas).toMatchObject({ ok: false, handoff: false });
    const outra = await run(tools.avecFreeSlots, {
      servico: "sobrancelha_design",
      profissional: "Mayara",
    });
    expect(String(outra.mensagem)).toMatch(/Rebeca/);
    expect(calls).toHaveLength(0);
  });

  it("avec_free_slots for a reschedule: same professional and service, one service that day only", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T15:00:00Z"));
    sameDay();
    answer(200, { data: [slot("447142", "2129417", "2026-10-24", "11:00")] });
    const r = await run(tools.avecFreeSlots, { remarcar_appointment_id: APPOINTMENT.id });
    expect(calls[2]!.url.searchParams.get("service_id")).toBe("2129417");
    expect(calls[2]!.url.searchParams.get("professional_id")).toBe("447142");
    expect(r.opcoes).toEqual([
      expect.objectContaining({
        opcao_id: "remarcar:-:447142-2129417-2026-10-24-1100",
        dia_semana: "sábado",
        profissional: "Rebeca",
      }),
    ]);
  });

  it("a visit of several services that day stays with the team", async () => {
    sameDay({ ...APPOINTMENT, id: "88123-2129318-447142-2026-10-23", service_id: "2129318" });
    const r = await run(tools.avecCancel, { appointment_id: APPOINTMENT.id });
    expect(r).toMatchObject({ ok: false, motivo: "visita_com_varios_servicos", handoff: true });
    expect(String(r.todo)).toMatch(/2 serviços/);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("avec_cancel", async () => {
    sameDay();
    answer(200, { id: APPOINTMENT.id, status: "cancelled" });
    const r = await run(tools.avecCancel, {
      appointment_id: APPOINTMENT.id,
      reason: "Ficou doente",
    });
    const call = calls[2]!;
    expect(call.method).toBe("POST");
    expect(call.url.pathname).toBe(`/v1/appointments/${APPOINTMENT.id}/cancel`);
    expect(call.body).toEqual({ phone: "+5514999990001", reason: "Ficou doente" });
    expect(call.headers["Idempotency-Key"]).toMatch(/^avec:job-1:avec_cancel:[0-9a-f]{16}$/);
    expect(r).toEqual({ ok: true, appointment_id: APPOINTMENT.id, status: "cancelled" });
  });

  it("avec_confirm confirms her whole day and answers it", async () => {
    const second = { ...APPOINTMENT, id: "88123-2129318-447142-2026-10-23", service_id: "2129318" };
    answer(200, {
      data: [
        { ...APPOINTMENT, status: "1.5", status_name: "Confirmado" },
        { ...second, status: "1.5", status_name: "Confirmado" },
      ],
    });
    const r = await run(tools.avecConfirm, { appointment_id: APPOINTMENT.id });
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.pathname).toBe(`/v1/appointments/${APPOINTMENT.id}/confirm`);
    expect(call.body).toEqual({ phone: "+5514999990001" });
    expect(call.headers["Idempotency-Key"]).toMatch(/^avec:job-1:avec_confirm:[0-9a-f]{16}$/);
    expect(r).toMatchObject({ ok: true, total: 2 });
    expect(r.agendamentos).toEqual([
      expect.objectContaining({ appointment_id: APPOINTMENT.id, status: "Confirmado" }),
      expect.objectContaining({ appointment_id: second.id, status: "Confirmado" }),
    ]);
  });

  it("avec_confirm not switched on yet goes to the team", async () => {
    problem(501, "not_implemented");
    const r = await run(tools.avecConfirm, { appointment_id: APPOINTMENT.id });
    expect(r).toMatchObject({ ok: false });
  });

  it("avec_reschedule returns the new appointment id", async () => {
    sameDay();
    answer(200, { ...APPOINTMENT, id: "88123-2129417-447142-2026-10-24", date: "2026-10-24" });
    const r = await run(tools.avecReschedule, {
      appointment_id: APPOINTMENT.id,
      opcao_id: "remarcar:-:447142-2129417-2026-10-24-1000",
    });
    expect(calls[2]!.url.pathname).toBe(`/v1/appointments/${APPOINTMENT.id}/reschedule`);
    expect(calls[2]!.body).toEqual({
      phone: "+5514999990001",
      slot_id: "447142-2129417-2026-10-24-1000",
    });
    expect(r).toMatchObject({
      ok: true,
      agendamento: { appointment_id: "88123-2129417-447142-2026-10-24", data_br: "24/10" },
    });
  });

  it("avec_reschedule refuses a slot of another service or professional", async () => {
    sameDay();
    const r = await run(tools.avecReschedule, {
      appointment_id: APPOINTMENT.id,
      opcao_id: "remarcar:-:430008-2128712-2026-10-24-1000",
    });
    expect(r).toMatchObject({ ok: false, handoff: false });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("avec_book books every step of the visit in the recipe's order, one key per step", async () => {
    const opcao =
      "corte_feminino_com_secagem:medio:430008-2128712-2026-10-27-1400+444091-2128749-2026-10-27-1400+444091-2129312-2026-10-27-1430";
    answer(201, {
      ...APPOINTMENT,
      service: "Corte Feminino",
      date: "2026-10-27",
      start_time: "14:00",
      end_time: "14:30",
    });
    answer(201, {
      ...APPOINTMENT,
      service: "Lavagem Para Corte",
      date: "2026-10-27",
      start_time: "14:00",
      end_time: "14:30",
    });
    answer(201, {
      ...APPOINTMENT,
      service: "Secagem Media",
      date: "2026-10-27",
      start_time: "14:30",
      end_time: "15:00",
    });
    const r = await run(tools.avecBook, { opcao_id: opcao, note: "Primeira vez" });
    expect(calls.map((c) => (c.body as { slot_id: string }).slot_id)).toEqual([
      "430008-2128712-2026-10-27-1400",
      "444091-2128749-2026-10-27-1400",
      "444091-2129312-2026-10-27-1430",
    ]);
    expect((calls[0]!.body as { note?: string }).note).toBe("Primeira vez");
    // The contact's name breaks a two-records-one-phone tie in avec; never the model's words.
    expect(
      calls.every((c) => (c.body as { client_name?: string }).client_name === "Ana Teste"),
    ).toBe(true);
    expect((calls[1]!.body as { note?: string }).note).toBeUndefined();
    expect(new Set(calls.map((c) => c.headers["Idempotency-Key"])).size).toBe(3);
    expect(r).toMatchObject({
      ok: true,
      agendamento: {
        dia_semana: "terça-feira",
        data_br: "27/10",
        inicio: "14:00",
        termina_por_volta_de: "15:00",
        profissional: "Mayara Morales",
      },
    });
  });

  it("two avec records on the phone: ask the full name, then book with it", async () => {
    problem(409, "ambiguous_client");
    const first = await run(tools.avecBook, { opcao_id: SOBRANCELHA_OPCAO });
    expect(first).toMatchObject({ ok: false, handoff: false, code: "ambiguous_client" });
    expect(String(first.mensagem)).toMatch(/nome completo/);

    answer(201, { ...APPOINTMENT, date: "2026-10-27" });
    const second = await run(tools.avecBook, {
      opcao_id: SOBRANCELHA_OPCAO,
      nome_completo: "Laura Teste",
    });
    expect(second).toMatchObject({ ok: true });
    expect(calls[1]!.body).toMatchObject({ client_name: "Laura Teste", name_must_match: true });
    expect(calls[1]!.headers["Idempotency-Key"]).not.toBe(calls[0]!.headers["Idempotency-Key"]);
    expect((calls[0]!.body as Record<string, unknown>).name_must_match).toBeUndefined();

    problem(409, "ambiguous_client");
    const third = await run(tools.avecBook, { opcao_id: SOBRANCELHA_OPCAO, nome_completo: "Ana" });
    expect(third).toMatchObject({ ok: false, handoff: true, code: "ambiguous_client" });
  });

  it("avec_book refuses an option the salon did not declare, before any call", async () => {
    for (const opcao_id of [
      "corte_feminino_com_secagem:medio:430008-2128712-2026-10-27-1400", // steps missing
      "corte_feminino_com_secagem:medio:430008-2128712-2026-10-27-1400+444091-2128749-2026-10-27-1400+797917-2129312-2026-10-27-1430", // two helpers
      "corte_feminino_com_secagem:medio:430008-2128712-2026-10-27-1400+444091-2128749-2026-10-27-1400+444091-2129312-2026-10-27-1500", // wrong offset
      "sobrancelha_design:-:430008-2129417-2026-10-27-1000", // not Rebeca
      "mechas:-:430008-2129430-2026-10-27-1000", // not an oferta
      "escova:-:444099-2128718-2026-10-27-1000", // length missing
    ]) {
      expect(await run(tools.avecBook, { opcao_id }), opcao_id).toMatchObject({
        ok: false,
        handoff: false,
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("avec_book hands off when a later step fails, saying what was booked and what is missing", async () => {
    const opcao =
      "sobrancelha_com_henna:-:447142-2129417-2026-10-27-1000+447142-2129318-2026-10-27-1030";
    answer(201, { ...APPOINTMENT, date: "2026-10-27" });
    problem(409, "slot_unavailable");
    const r = await run(tools.avecBook, { opcao_id: opcao });
    expect(r).toMatchObject({ ok: false, handoff: true, parcial: true });
    expect(String(r.todo)).toMatch(/Ficou marcado no avec: Sobrancelha 27\/10 10:00/);
    expect(String(r.todo)).toMatch(/Falta marcar a etapa 2 .* às 10:30 \(Rebeca\)/);
  });
});

describe("errors → handoff", () => {
  const cases: Array<[number, string, boolean]> = [
    [401, "unauthorized", true],
    [404, "not_found", false],
    [409, "ambiguous_appointment", true],
    [409, "ambiguous_client", false], // asks the full name first; with it, hands off (below)
    [409, "idempotency_in_flight", false],
    [409, "already_booked", false],
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
    const r = await run(tools.avecBook, { opcao_id: SOBRANCELHA_OPCAO });
    expect(r).toMatchObject({ ok: false, code, handoff });
    if (handoff) expect(r.todo).toEqual(expect.any(String));
    // The client never hears the receptionist's name, only "nossa equipe de atendimento".
    expect(String(r.mensagem ?? "")).not.toMatch(/Ruth/);
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
    sameDay();
    answers.push(err);
    const r = await run(tools.avecCancel, { appointment_id: APPOINTMENT.id });
    expect(r).toMatchObject({ ok: false, code: "timeout", handoff: true });
    expect(r.todo).toMatch(/Conferir no avec/);
  });

  it("the first slot_unavailable asks for new slots, the second hands off", async () => {
    problem(409, "slot_unavailable");
    problem(409, "slot_unavailable");
    const first = await run(tools.avecBook, { opcao_id: SOBRANCELHA_OPCAO });
    const second = await run(tools.avecBook, {
      opcao_id: "sobrancelha_design:-:447142-2129417-2026-10-27-1030",
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

describe("status", () => {
  it("shows the status name and whether the API lets it change", async () => {
    answer(200, {
      data: [
        { ...APPOINTMENT, status: "1.5", status_name: "Confirmado" },
        { ...APPOINTMENT, id: "x-2", status: "3", status_name: "Em Atendimento" },
      ],
    });
    restOfWindows();
    const r = await run(tools.avecMyAppointments, {});
    expect(r.agendamentos).toMatchObject([
      { status: "Confirmado", can_change: true },
      { status: "Em Atendimento", can_change: false },
    ]);
  });
});

describe("weekday", () => {
  it("is computed in code, in Portuguese, so the agent never calculates it", async () => {
    expect(tools.weekdayOf("2026-10-23")).toBe("sexta-feira");
    expect(tools.weekdayOf("2026-10-25")).toBe("domingo");
    expect(tools.weekdayOf("nope")).toBeNull();
    answer(200, { data: [APPOINTMENT] });
    restOfWindows();
    const r = await run(tools.avecMyAppointments, {});
    expect((r.agendamentos as Array<{ weekday: string }>)[0]!.weekday).toBe("sexta-feira");
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
    expect(
      tools.avecBook.redigirParaAuditoria!({
        opcao_id: "s",
        note: "alergia",
        nome_completo: "Laura",
      }),
    ).toEqual({
      opcao_id: "s",
      nome_completo: "[redacted]",
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
    "avec_confirm",
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
    for (const name of ["avec_book", "avec_reschedule", "avec_confirm", "avec_cancel"]) {
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

// ---------------------------------------------------------------------------
// avec_my_appointments: 60 days in 14-day windows
// ---------------------------------------------------------------------------

describe("avec_my_appointments window", () => {
  it("reads 60 days ahead in consecutive windows of at most 14 days, one after the other", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-26T15:00:00Z"));
    const later = { ...APPOINTMENT, id: "88123-2129417-447142-2026-12-30", date: "2026-12-30" };
    const sooner = { ...APPOINTMENT, id: "88123-2129417-447142-2026-11-28", date: "2026-11-28" };
    answer(200, { data: [sooner] });
    answer(200, { data: [] });
    answer(200, { data: [later] });
    answer(200, { data: [] });
    answer(200, { data: [] });
    const r = await run(tools.avecMyAppointments, {});
    expect(calls.map((c) => [c.url.searchParams.get("from"), c.url.searchParams.get("to")])).toEqual([
      ["2026-11-26", "2026-12-09"],
      ["2026-12-10", "2026-12-23"],
      ["2026-12-24", "2027-01-06"],
      ["2027-01-07", "2027-01-20"],
      ["2027-01-21", "2027-01-24"],
    ]);
    expect(calls.every((c) => c.method === "GET" && c.url.searchParams.get("phone") === "+5514999990001")).toBe(true);
    expect(r).toMatchObject({ ok: true, total: 2, periodo: { de: "26/11", ate: "24/01" } });
    expect((r.agendamentos as Array<{ date: string }>).map((a) => a.date)).toEqual([
      "2026-11-28",
      "2026-12-30",
    ]);
  });

  it("a range of the agent's is capped at 60 days, and a short one is one call", async () => {
    for (let i = 0; i < 5; i++) answer(200, { data: [] });
    await run(tools.avecMyAppointments, { from: "2026-12-01", to: "2027-06-01" });
    expect(calls).toHaveLength(5);
    expect(calls.at(-1)!.url.searchParams.get("to")).toBe("2027-01-29");
  });

  it("an inverted range is refused without calling avec", async () => {
    const r = await run(tools.avecMyAppointments, { from: "2026-12-10", to: "2026-12-01" });
    expect(r).toMatchObject({ ok: false, handoff: false });
    expect(calls).toHaveLength(0);
  });

  it("a window that fails hands off like any read", async () => {
    answer(200, { data: [] });
    problem(503, "avec_unavailable");
    const r = await run(tools.avecMyAppointments, {});
    expect(r).toMatchObject({ ok: false, code: "avec_unavailable", handoff: true });
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// a visit of several bookings: corte feminino com secagem (cabelo médio) with Mayara
// ---------------------------------------------------------------------------

const CORTE = {
  ...APPOINTMENT,
  id: "88123-2128712-430008-2026-10-27",
  service_id: "2128712",
  service: "Corte Feminino",
  professional_id: "430008",
  professional: "Mayara Morales",
  date: "2026-10-27",
  start_time: "14:00",
  end_time: "14:30",
  starts_at: "2026-10-27T14:00:00-03:00",
};
const LAVAGEM = {
  ...CORTE,
  id: "88123-2128749-797917-2026-10-27",
  service_id: "2128749",
  service: "Lavagem Para Corte",
  professional_id: "797917",
  professional: "Júlia",
};
const SECAGEM = {
  ...LAVAGEM,
  id: "88123-2129312-797917-2026-10-27",
  service_id: "2129312",
  service: "Secagem Media",
  start_time: "14:30",
  end_time: "15:00",
};
const VISITA = [LAVAGEM, CORTE, SECAGEM]; // avec's order is not the recipe's

/** The two reads every change starts with, for a booking of the three-step visit. */
function visitDay(target: typeof CORTE = SECAGEM, day: Array<typeof CORTE> = VISITA) {
  answer(200, target);
  answer(200, { data: day });
}

const NOVA =
  "corte_feminino_com_secagem:medio:430008-2128712-2026-10-28-1500+797917-2128749-2026-10-28-1500+797917-2129312-2026-10-28-1530";
const NOVAS_SLOTS = NOVA.split(":")[2]!.split("+");

/** avec-api's answer to `POST /v1/appointments` for one slot id. */
function created(slotId: string) {
  const [prof, service, y, m, d, hhmm] = slotId.split("-") as [string, string, string, string, string, string];
  const date = `${y}-${m}-${d}`;
  const start = `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
  return {
    ...CORTE,
    id: `88123-${service}-${prof}-${date}`,
    service_id: service,
    professional_id: prof,
    date,
    start_time: start,
    end_time: start === "15:00" ? "15:30" : "16:00",
  };
}

const posts = () => calls.filter((c) => c.method === "POST");

describe("a visit of several bookings", () => {
  it("avec_cancel cancels every booking of the visit, one /cancel and one key each", async () => {
    visitDay();
    for (const a of [CORTE, LAVAGEM, SECAGEM]) answer(200, { id: a.id, status: "cancelled" });
    const r = await run(tools.avecCancel, { appointment_id: SECAGEM.id, reason: "Viagem" });
    expect(posts().map((c) => c.url.pathname)).toEqual([
      `/v1/appointments/${CORTE.id}/cancel`,
      `/v1/appointments/${LAVAGEM.id}/cancel`,
      `/v1/appointments/${SECAGEM.id}/cancel`,
    ]);
    expect(posts().every((c) => /^avec:job-1:avec_cancel:[0-9a-f]{16}$/.test(c.headers["Idempotency-Key"]!))).toBe(true);
    expect(new Set(posts().map((c) => c.headers["Idempotency-Key"])).size).toBe(3);
    expect(posts()[0]!.body).toEqual({ phone: "+5514999990001", reason: "Viagem" });
    expect(r).toMatchObject({ ok: true, total: 3 });
    expect(JSON.stringify(r)).not.toMatch(/Ana Teste|99999-0001|client_/);
  });

  it("avec_cancel that fails halfway still tries the rest and says exactly what is left", async () => {
    visitDay();
    answer(200, { id: CORTE.id, status: "cancelled" });
    problem(502, "avec_error");
    answer(200, { id: SECAGEM.id, status: "cancelled" });
    const r = await run(tools.avecCancel, { appointment_id: CORTE.id });
    expect(posts()).toHaveLength(3);
    expect(r).toMatchObject({ ok: false, handoff: true, parcial: true });
    expect(String(r.todo)).toMatch(/Cancelado no avec: Corte Feminino 27\/10 14:00 \(Mayara Morales\); Secagem Media 27\/10 14:30/);
    expect(String(r.todo)).toMatch(/Falta cancelar: Lavagem Para Corte 27\/10 14:00 \(Júlia\)\./);
  });

  it("avec_cancel where nothing was cancelled answers like a one-service cancel", async () => {
    visitDay();
    for (let i = 0; i < 3; i++) problem(422, "not_allowed");
    const r = await run(tools.avecCancel, { appointment_id: CORTE.id });
    expect(r).toMatchObject({ ok: false, code: "not_allowed", handoff: true });
    expect(r.parcial).toBeUndefined();
  });

  it("a day that is more than one recipe stays with the team", async () => {
    const outra = { ...APPOINTMENT, id: "88123-2129417-447142-2026-10-27", date: "2026-10-27", start_time: "17:00" };
    visitDay(CORTE, [...VISITA, outra]);
    const r = await run(tools.avecCancel, { appointment_id: CORTE.id });
    expect(r).toMatchObject({ ok: false, motivo: "visita_com_varios_servicos", handoff: true });
    expect(String(r.todo)).toMatch(/4 serviços/);
    expect(posts()).toHaveLength(0);
  });

  it("a visit with a booking already in progress cannot change", async () => {
    visitDay(CORTE, [LAVAGEM, CORTE, { ...SECAGEM, status: "3" }]);
    const r = await run(tools.avecCancel, { appointment_id: CORTE.id });
    expect(r).toMatchObject({ ok: false, motivo: "not_allowed", handoff: true });
    expect(posts()).toHaveLength(0);
  });

  it("avec_free_slots for a reschedule searches the whole visit by its recipe, never the same day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T15:00:00Z"));
    visitDay();
    answer(200, {
      data: [slot("430008", "2128712", "2026-10-28", "15:00"), slot("430008", "2128712", "2026-10-27", "16:00")],
    });
    answer(200, {
      data: [slot("797917", "2128749", "2026-10-28", "15:00"), slot("797917", "2128749", "2026-10-27", "16:00")],
    });
    answer(200, {
      data: [slot("797917", "2129312", "2026-10-28", "15:30"), slot("797917", "2129312", "2026-10-27", "16:30")],
    });
    const r = await run(tools.avecFreeSlots, { remarcar_appointment_id: SECAGEM.id });
    const searched = calls.slice(2).map((c) => [c.url.searchParams.get("service_id"), c.url.searchParams.get("professional_id")]);
    expect(searched).toEqual([
      ["2128712", "430008"],
      ["2128749", null],
      ["2129312", null],
    ]);
    expect(r.opcoes).toEqual([
      expect.objectContaining({ opcao_id: NOVA, data_br: "28/10", inicio: "15:00", profissional: "Mayara Morales" }),
    ]);
  });

  it("avec_free_slots for the same day of a visit goes to the team", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T15:00:00Z"));
    visitDay();
    const r = await run(tools.avecFreeSlots, { remarcar_appointment_id: CORTE.id, data: "2026-10-27" });
    expect(r).toMatchObject({ ok: false, motivo: "mesmo_dia_com_a_equipe", handoff: true });
    expect(calls).toHaveLength(2);
  });

  it("avec_reschedule books the new visit first, then cancels the old bookings", async () => {
    visitDay();
    for (const s of NOVAS_SLOTS) answer(201, created(s));
    for (const a of [CORTE, LAVAGEM, SECAGEM]) answer(200, { id: a.id, status: "cancelled" });
    const r = await run(tools.avecReschedule, { appointment_id: SECAGEM.id, opcao_id: NOVA });
    const writes = posts();
    expect(writes.map((c) => c.url.pathname)).toEqual([
      "/v1/appointments",
      "/v1/appointments",
      "/v1/appointments",
      `/v1/appointments/${CORTE.id}/cancel`,
      `/v1/appointments/${LAVAGEM.id}/cancel`,
      `/v1/appointments/${SECAGEM.id}/cancel`,
    ]);
    expect(writes.slice(0, 3).map((c) => (c.body as { slot_id: string }).slot_id)).toEqual(NOVAS_SLOTS);
    expect(writes.every((c) => /^avec:job-1:avec_reschedule:[0-9a-f]{16}$/.test(c.headers["Idempotency-Key"]!))).toBe(true);
    expect(new Set(writes.map((c) => c.headers["Idempotency-Key"])).size).toBe(6);
    expect((writes[0]!.body as { note?: string }).note).toMatch(/era 27\/10 às 14:00/);
    expect(r).toMatchObject({
      ok: true,
      agendamento: { data_br: "28/10", inicio: "15:00", profissional: "Mayara Morales" },
    });
    expect(r.handoff).toBeUndefined();
    expect(JSON.stringify(r)).not.toMatch(/Ana Teste|99999-0001|client_/);
  });

  it("avec_reschedule that cannot book the first step leaves the old visit untouched", async () => {
    visitDay();
    problem(409, "slot_unavailable");
    const r = await run(tools.avecReschedule, { appointment_id: CORTE.id, opcao_id: NOVA });
    expect(posts()).toHaveLength(1);
    expect(r).toMatchObject({ ok: false, code: "slot_unavailable", handoff: false, visita_antiga_mantida: true });
  });

  it("avec_reschedule that books the new visit in part cancels nothing and hands off", async () => {
    visitDay();
    answer(201, created(NOVAS_SLOTS[0]!));
    problem(502, "avec_write_unconfirmed");
    const r = await run(tools.avecReschedule, { appointment_id: CORTE.id, opcao_id: NOVA });
    expect(posts()).toHaveLength(2);
    expect(posts().some((c) => c.url.pathname.endsWith("/cancel"))).toBe(false);
    expect(r).toMatchObject({ ok: false, handoff: true, parcial: true, visita_antiga_mantida: true });
    expect(String(r.mensagem)).toMatch(/continua valendo o horário de 27\/10 às 14:00/);
    expect(String(r.todo)).toMatch(/A visita antiga continua marcada no avec: Corte Feminino 27\/10 14:00/);
    expect(String(r.todo)).toMatch(/Da visita nova ficou marcado: Corte Feminino 28\/10 15:00/);
    expect(String(r.todo)).toMatch(/Falta marcar a etapa 2 .* às 15:00 \(Júlia\), que pode já ter entrado/);
  });

  it("avec_reschedule whose old visit is cancelled in part confirms the new one and hands off the rest", async () => {
    visitDay();
    for (const s of NOVAS_SLOTS) answer(201, created(s));
    answer(200, { id: CORTE.id, status: "cancelled" });
    answer(200, { id: LAVAGEM.id, status: "cancelled" });
    problem(502, "avec_error");
    const r = await run(tools.avecReschedule, { appointment_id: CORTE.id, opcao_id: NOVA });
    expect(r).toMatchObject({ ok: true, handoff: true, visita_antiga_cancelada_em_parte: true });
    expect(String(r.mensagem)).toMatch(/confirme o novo horário/);
    expect(String(r.todo)).toMatch(/Cancelar no avec o que sobrou da antiga: Secagem Media 27\/10 14:30 \(Júlia\)\./);
  });

  it("avec_reschedule refuses an option of another recipe, a one-service option, or the same day", async () => {
    const eliton =
      "corte_feminino_com_secagem:medio:447143-3238931-2026-10-28-1500+797917-2128749-2026-10-28-1500+447143-2129312-2026-10-28-1530";
    const mesmoDia =
      "corte_feminino_com_secagem:medio:430008-2128712-2026-10-27-1600+797917-2128749-2026-10-27-1600+797917-2129312-2026-10-27-1630";
    for (const opcao_id of [eliton, "remarcar:-:430008-2128712-2026-10-28-1500"]) {
      visitDay();
      expect(await run(tools.avecReschedule, { appointment_id: CORTE.id, opcao_id }), opcao_id).toMatchObject({
        ok: false,
        handoff: false,
      });
    }
    visitDay();
    expect(await run(tools.avecReschedule, { appointment_id: CORTE.id, opcao_id: mesmoDia })).toMatchObject({
      ok: false,
      motivo: "mesmo_dia_com_a_equipe",
      handoff: true,
    });
    expect(posts()).toHaveLength(0);
  });

  it("a malformed opcao_id is refused before any call", async () => {
    const r = await run(tools.avecReschedule, { appointment_id: CORTE.id, opcao_id: "corte:medio:x" });
    expect(r).toMatchObject({ ok: false, handoff: false });
    expect(calls).toHaveLength(0);
  });
});

describe("review fixes (PR #169)", () => {
  it("a whole-visit cancel where nothing is confirmed hands off when one cancel may have gone through", async () => {
    visitDay();
    problem(409, "idempotency_in_flight");
    const timeout = new Error("aborted");
    timeout.name = "TimeoutError";
    answers.push(timeout);
    problem(422, "not_allowed");
    const r = await run(tools.avecCancel, { appointment_id: CORTE.id });
    expect(r).toMatchObject({ ok: false, code: "timeout", handoff: true });
    expect(String(r.todo)).toMatch(/Conferir no avec/);
  });

  it("a booking already gone from avec (not_found) counts as cancelled, not as left over", async () => {
    visitDay();
    answer(200, { id: CORTE.id, status: "cancelled" });
    problem(404, "not_found");
    answer(200, { id: SECAGEM.id, status: "cancelled" });
    const r = await run(tools.avecCancel, { appointment_id: CORTE.id });
    expect(r).toMatchObject({ ok: true, total: 3 });
  });

  it("a move refused with already_booked keeps the old visit and asks for another day", async () => {
    visitDay();
    problem(409, "already_booked");
    const r = await run(tools.avecReschedule, { appointment_id: CORTE.id, opcao_id: NOVA });
    expect(r).toMatchObject({ ok: false, code: "already_booked", handoff: false, visita_antiga_mantida: true });
    expect(String(r.mensagem)).toMatch(/outro dia/);
    expect(posts()).toHaveLength(1);
  });

  it("only an end date in the past reads the two weeks before it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-26T15:00:00Z"));
    answer(200, { data: [] });
    const r = await run(tools.avecMyAppointments, { to: "2026-11-20" });
    expect(r).toMatchObject({ ok: true });
    expect(calls.map((c) => [c.url.searchParams.get("from"), c.url.searchParams.get("to")])).toEqual([
      ["2026-11-07", "2026-11-20"],
    ]);
  });

  it("a whole-visit search honours the helper the client asked for", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T15:00:00Z"));
    visitDay();
    answer(200, { data: [slot("430008", "2128712", "2026-10-28", "15:00")] });
    answer(200, { data: [slot("444099", "2128749", "2026-10-28", "15:00")] });
    answer(200, { data: [slot("444099", "2129312", "2026-10-28", "15:30")] });
    const r = await run(tools.avecFreeSlots, { remarcar_appointment_id: SECAGEM.id, auxiliar: "Simone" });
    expect(calls.slice(2).map((c) => c.url.searchParams.get("professional_id"))).toEqual([
      "430008",
      "444099",
      "444099",
    ]);
    expect(r.opcoes).toEqual([
      expect.objectContaining({
        opcao_id:
          "corte_feminino_com_secagem:medio:430008-2128712-2026-10-28-1500+444099-2128749-2026-10-28-1500+444099-2129312-2026-10-28-1530",
        tambem_com: "Simone",
      }),
    ]);
  });
});
