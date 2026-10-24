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
