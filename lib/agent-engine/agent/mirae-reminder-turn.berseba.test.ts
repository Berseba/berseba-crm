// @vitest-environment node
/**
 * Berseba: the agent turn of a Mirae reminder. A draft goes to the inbox whatever the agent's
 * mode; an automatic one goes through the normal turn (send window, gate); the briefing is
 * orientation, never the message; a reminder that would arrive too late is dropped.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { sentChargeMessages } from "@/lib/integrations/mirae/charge-sent";

import { SPINNING_DEFAULTS } from "../spinning/defaults";
import { decideSpinning, hashNormalized, normalizeCopy } from "../spinning/engine";

import {
  avisarLembreteQueNaoSaiu,
  briefingDoLembrete,
  decisaoDoLembrete,
  MiraeUnavailableError,
  chegaTardeDemais,
  lembreteDoMirae,
  quandoLegivel,
  runMiraeReminderTurn,
  trazValorEVencimento,
  valorLegivel,
  vencimentoLegivel,
  type MiraeReminderPayload,
} from "./mirae-reminder-turn.berseba";

const REMINDER: MiraeReminderPayload = {
  delivery_key: "rem-1:2026-11-18T12:00:00.000Z",
  reminder_id: "rem-1",
  delivery: "auto",
  kind: "evaluation_confirmation",
  title: "Confirmar avaliação",
  note: "Trazer roupa confortável",
  student_name: "Ana",
  appointment_start_at: "2026-11-18T12:00:00.000Z",
  professional_first_name: "Raquel",
};
const BOUNDARY = {
  organization_id: "org",
  contact_id: "contact",
  conversation_id: "conv",
  service_revision: 2,
  demanda_id: null,
  demanda_revision: null,
};
const TARGET = {
  tenantId: "org",
  leadId: "contact",
  conversationId: "conv",
  channelSessionId: "channel",
  boundary: BOUNDARY,
};
const NOW = new Date("2026-11-17T12:00:00.000Z");
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const deps = { log } as never;
const JOB = { id: "job-1", organization_id: "org", contact_id: "contact", kind: "followup_turn", payload: {}, attempts: 1, max_attempts: 5 };
const job = JOB as never;

function ports(over: Record<string, unknown> = {}) {
  return {
    runAgentTurn: vi.fn(async () => undefined),
    generateReplyDraft: vi.fn(async () => ({ id: "draft-1", status: "pending" })),
    fuso: vi.fn(async () => "America/Sao_Paulo"),
    checkAppointment: vi.fn(async (): Promise<"confirmed" | "gone" | "unknown" | "unavailable"> => "confirmed"),
    avisar: vi.fn(async () => undefined),
    sentCharge: vi.fn(async (): Promise<string[]> => []),
    ...over,
  };
}

describe("lembreteDoMirae", () => {
  it("reads the reminder of a Mirae return and ignores every other return", () => {
    expect(lembreteDoMirae({ source: "mirae_reminder", mirae_reminder: REMINDER })).toEqual(REMINDER);
    expect(lembreteDoMirae({ reason: "x", promise: "y" })).toBeNull();
    expect(lembreteDoMirae({ source: "reactivation", mirae_reminder: REMINDER })).toBeNull();
    expect(lembreteDoMirae({ source: "mirae_reminder", mirae_reminder: { delivery: "auto" } })).toBeNull();
    expect(lembreteDoMirae(null)).toBeNull();
  });
});

describe("chegaTardeDemais", () => {
  it("less than an hour before the appointment, or after it, is too late", () => {
    expect(chegaTardeDemais(REMINDER, NOW)).toBe(false);
    expect(chegaTardeDemais(REMINDER, new Date("2026-11-18T11:00:00.000Z"))).toBe(false);
    expect(chegaTardeDemais(REMINDER, new Date("2026-11-18T11:00:01.000Z"))).toBe(true);
    expect(chegaTardeDemais(REMINDER, new Date("2026-11-18T13:00:00.000Z"))).toBe(true);
    expect(chegaTardeDemais({ ...REMINDER, appointment_start_at: null }, NOW)).toBe(false);
  });
});

describe("briefingDoLembrete", () => {
  it("formats the appointment in the organization's time zone", () => {
    expect(quandoLegivel("2026-11-18T12:00:00.000Z", "America/Sao_Paulo")).toBe(
      "quarta-feira, 18/11 às 09:00",
    );
    expect(quandoLegivel("not a date", "America/Sao_Paulo")).toBeNull();
  });

  it("a confirmation: the data, ask to confirm, and when to send nothing", () => {
    const b = briefingDoLembrete(REMINDER, "America/Sao_Paulo");
    expect(b).toContain("avaliação inicial");
    expect(b).toContain("Ana");
    expect(b).toContain("quarta-feira, 18/11 às 09:00");
    expect(b).toContain("Com: Raquel");
    expect(b).toContain("Confirmar avaliação");
    expect(b).toContain("Trazer roupa confortável");
    expect(b).toContain("peça para a pessoa confirmar");
    expect(b).toContain("já confirmou ESTE mesmo agendamento");
    expect(b).toContain("pediu para não receber mensagens");
    expect(b).toContain("cancelado ou remarcado");
    expect(b).toContain("orientação (dados), não o texto da mensagem");
    expect(b).toContain("Não agende retorno");
  });

  it("a first class names it", () => {
    expect(briefingDoLembrete({ ...REMINDER, kind: "first_class_confirmation" }, "UTC")).toContain(
      "primeira aula",
    );
  });

  it("a manual reminder does not ask for a confirmation, and leaves out what it lacks", () => {
    const b = briefingDoLembrete(
      {
        ...REMINDER,
        kind: "manual",
        note: null,
        student_name: null,
        appointment_start_at: null,
        professional_first_name: null,
      },
      "America/Sao_Paulo",
    );
    expect(b).not.toContain("confirmar a presença");
    expect(b).not.toContain("Quando:");
    expect(b).not.toContain("Observação");
    expect(b).toContain("sobre o que a equipe pediu");
  });
});

describe("runMiraeReminderTurn", () => {
  it("draft: an agent draft with the briefing, never a turn that sends", async () => {
    const p = ports();
    await runMiraeReminderTurn(deps, job, {} as never, { workerId: "w" }, () => NOW, TARGET, { ...REMINDER, delivery: "draft" }, p as never);
    expect(p.runAgentTurn).not.toHaveBeenCalled();
    expect(p.generateReplyDraft).toHaveBeenCalledTimes(1);
    const input = (p.generateReplyDraft.mock.calls[0] as unknown as [unknown, unknown, Record<string, unknown>])[2];
    expect(input).toMatchObject({
      organizationId: "org",
      conversationId: "conv",
      contactId: "contact",
      channelId: "channel",
      boundary: BOUNDARY,
    });
    expect(input.aberturaExtra).toContain("## Lembrete do estúdio (agenda Mirae)");
  });

  it("draft: no agent, or a contact nobody may write to, ends quietly; any other error is retried", async () => {
    for (const reason of ["reply_no_agent", "reply_context_unavailable"]) {
      const p = ports({ generateReplyDraft: vi.fn(async () => { throw new Error(reason); }) });
      await expect(
        runMiraeReminderTurn(deps, job, {} as never, { workerId: "w" }, () => NOW, TARGET, { ...REMINDER, delivery: "draft" }, p as never),
      ).resolves.toBeUndefined();
      expect(p.avisar).toHaveBeenCalledTimes(1);
    }
    const p = ports({ generateReplyDraft: vi.fn(async () => { throw new Error("db down"); }) });
    await expect(
      runMiraeReminderTurn(deps, job, {} as never, { workerId: "w" }, () => NOW, TARGET, { ...REMINDER, delivery: "draft" }, p as never),
    ).rejects.toThrow("db down");
  });

  it("auto: the agent's normal turn, with the briefing in the opening and for an assisted agent", async () => {
    const p = ports();
    await runMiraeReminderTurn(deps, job, {} as never, { workerId: "w" }, () => NOW, TARGET, REMINDER, p as never);
    expect(p.generateReplyDraft).not.toHaveBeenCalled();
    expect(p.runAgentTurn).toHaveBeenCalledTimes(1);
    const input = (p.runAgentTurn.mock.calls[0] as unknown as [unknown, unknown, unknown, unknown, Record<string, unknown>])[4];
    expect(input).toMatchObject({ channelSessionId: "channel", conversationId: "conv" });
    expect(input.aberturaDoRascunho).toContain("## Lembrete do estúdio (agenda Mirae)");
    const opening = (input.buildOpening as (r: unknown) => string)({
      previous: null,
      leadState: null,
      context: { contact: { name: "Ana", email: null }, messages: [] },
      notesIndexBlock: "sem notas",
      projeta: false,
    });
    expect(opening).toContain("NÃO houve mensagem nova desta pessoa");
    expect(opening).toContain("## Lembrete do estúdio (agenda Mirae)");
    expect(opening).toContain("send_message");
    expect(opening).toContain("Checkpoint anterior");
  });

  describe("the appointment is checked in Mirae right before the turn", () => {
    const run = (p: ReturnType<typeof ports>, r: MiraeReminderPayload = REMINDER, j: unknown = job) =>
      runMiraeReminderTurn(deps, j as never, {} as never, { workerId: "w" }, () => NOW, TARGET, r, p as never);
    const turnInput = (p: ReturnType<typeof ports>) =>
      (p.runAgentTurn.mock.calls[0] as unknown as [unknown, unknown, unknown, unknown, Record<string, unknown>])[4];

    it.each(["auto", "draft"] as const)("%s: gone (cancelled or moved) → nothing is sent nor drafted", async (delivery) => {
      const p = ports({ checkAppointment: vi.fn(async () => "gone" as const) });
      await run(p, { ...REMINDER, delivery, mirae_phone: "14996598955" });
      expect(p.checkAppointment).toHaveBeenCalledWith({}, {
        organizationId: "org",
        contactId: "contact",
        appointmentStartAt: "2026-11-18T12:00:00.000Z",
        miraePhone: "14996598955",
      });
      expect(p.runAgentTurn).not.toHaveBeenCalled();
      expect(p.generateReplyDraft).not.toHaveBeenCalled();
      // Mirae was told the reminder is on its way: the team hears it did not go out.
      expect(p.avisar).toHaveBeenCalledTimes(1);
      expect((p.avisar.mock.calls[0] as unknown as [unknown, { motivo: string }])[1].motivo).toContain(
        "não estava mais marcado",
      );
    });

    it("confirmed → the turn runs, and the agent still reads the appointment (proof for the promise reviewer)", async () => {
      const p = ports();
      await run(p);
      const input = turnInput(p);
      expect(input.aberturaDoRascunho).toContain("acabou de conferir na agenda do estúdio");
      expect(input.aberturaDoRascunho).toContain("ANTES de escrever, chame mirae_my_appointments");
      expect(input.aberturaDoRascunho).toContain("se a ferramenta");
      expect(input.aberturaDoRascunho).toContain("feriado");
    });

    it("auto, Mirae unavailable: retried while tries are left, then a draft", async () => {
      const p = ports({ checkAppointment: vi.fn(async () => "unavailable" as const) });
      await expect(run(p, REMINDER, { ...JOB, attempts: 1 })).rejects.toBeInstanceOf(MiraeUnavailableError);
      await expect(run(p, REMINDER, { ...JOB, attempts: 2 })).rejects.toBeInstanceOf(MiraeUnavailableError);
      expect(p.runAgentTurn).not.toHaveBeenCalled();
      await run(p, REMINDER, { ...JOB, attempts: 3 });
      expect(p.runAgentTurn).not.toHaveBeenCalled();
      expect(p.generateReplyDraft).toHaveBeenCalledTimes(1);
    });

    it("auto, Mirae does not know the person (unknown): a draft right away", async () => {
      const p = ports({ checkAppointment: vi.fn(async () => "unknown" as const) });
      await run(p);
      expect(p.runAgentTurn).not.toHaveBeenCalled();
      expect(p.generateReplyDraft).toHaveBeenCalledTimes(1);
    });

    it("draft, Mirae unavailable: drafted anyway (a person reviews it)", async () => {
      const p = ports({ checkAppointment: vi.fn(async () => "unavailable" as const) });
      await run(p, { ...REMINDER, delivery: "draft" });
      expect(p.generateReplyDraft).toHaveBeenCalledTimes(1);
    });

    it("a manual reminder, or one without a time, is not checked", async () => {
      const p = ports();
      await run(p, { ...REMINDER, kind: "manual" });
      await run(p, { ...REMINDER, appointment_start_at: null });
      expect(p.checkAppointment).not.toHaveBeenCalled();
    });
  });

  describe("decisaoDoLembrete", () => {
    const t = (attempts: number, maxAttempts = 5) => ({ attempts, maxAttempts });
    it("covers every answer", () => {
      expect(decisaoDoLembrete({ delivery: "auto" }, "gone", t(1))).toEqual({ kind: "drop" });
      expect(decisaoDoLembrete({ delivery: "draft" }, "gone", t(1))).toEqual({ kind: "drop" });
      expect(decisaoDoLembrete({ delivery: "auto" }, "confirmed", t(1))).toEqual({ kind: "run", delivery: "auto" });
      expect(decisaoDoLembrete({ delivery: "auto" }, "unknown", t(1))).toEqual({ kind: "run", delivery: "draft" });
      expect(decisaoDoLembrete({ delivery: "auto" }, "unavailable", t(2))).toEqual({ kind: "retry" });
      expect(decisaoDoLembrete({ delivery: "auto" }, "unavailable", t(3))).toEqual({ kind: "run", delivery: "draft" });
      // A queue with fewer tries than ours never lets the job die waiting for Mirae.
      expect(decisaoDoLembrete({ delivery: "auto" }, "unavailable", t(2, 2))).toEqual({ kind: "run", delivery: "draft" });
      expect(decisaoDoLembrete({ delivery: "draft" }, "unavailable", t(1))).toEqual({ kind: "run", delivery: "draft" });
    });
  });

  it("too close to the appointment: nothing runs, and the team is told", async () => {
    const p = ports();
    await runMiraeReminderTurn(deps, job, {} as never, { workerId: "w" }, () => new Date("2026-11-18T11:30:00.000Z"), TARGET, REMINDER, p as never);
    expect(p.runAgentTurn).not.toHaveBeenCalled();
    expect(p.generateReplyDraft).not.toHaveBeenCalled();
    expect(p.avisar).toHaveBeenCalledTimes(1);
    expect((p.avisar.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1]).toMatchObject({
      tenantId: "org",
      conversationId: "conv",
    });
  });

  it("the notice goes to the Central, linked to the conversation", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: "item" }] }));
    await avisarLembreteQueNaoSaiu({ query } as never, {
      tenantId: "org",
      conversationId: "conv",
      reminder: REMINDER,
      motivo: "Motivo.",
    });
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("agent_inbox_items");
    expect(params).toEqual(expect.arrayContaining(["org", "followup_dead", "conversation", "conv"]));
  });
});

describe("wiring (source contract)", () => {
  const ler = (f: string) => readFileSync(join(process.cwd(), "lib/agent-engine/agent", f), "utf8");

  it("the followup turn hands a Mirae reminder over after the channel and boundary checks", () => {
    const fonte = ler("followup-turn.ts");
    const iBoundary = fonte.indexOf("await requireCurrentServiceBoundary(pool, boundary);");
    const iCanal = fonte.indexOf("if (targetRows[0].canal_desativado === 'true')");
    const iLembrete = fonte.indexOf("const lembrete = lembreteDoMirae(job.payload);");
    const iTemplate = fonte.indexOf("if (payload.mode === 'template')");
    expect(iBoundary).toBeGreaterThan(-1);
    expect(iLembrete).toBeGreaterThan(iCanal);
    expect(iLembrete).toBeGreaterThan(iBoundary);
    expect(iTemplate).toBeGreaterThan(iLembrete);
    // A Mirae payload this worker cannot read stops before the generic return turn.
    const iIlegivel = fonte.indexOf("if (job.payload?.source === MIRAE_REMINDER_SOURCE) {");
    expect(iIlegivel).toBeGreaterThan(iLembrete);
    expect(iTemplate).toBeGreaterThan(iIlegivel);
    expect(fonte.slice(iIlegivel, iIlegivel + 200)).toContain("await avisarLembreteIlegivel(");
  });

  it("an automatic reminder is a turn that talks to the person: the send window defers it", () => {
    // `runAgentTurn` defers (never drops) a turn outside the window when
    // `turnoVaiFalarComOLead` says so; a followup_turn without `purpose` does.
    const fonte = ler("inbound-turn.ts");
    const i = fonte.indexOf("function turnoVaiFalarComOLead");
    expect(fonte.slice(i, i + 400)).toContain("return purpose === undefined || purpose === 'send_message';");
    expect(fonte).toContain("if (!janelaDeEnvioAberta(agora, knobs, resposta)) {");
    expect(fonte).toContain("await rescheduleJob(pool, liveJob().id, ctx.workerId, {");
  });

  it("the assisted branch and the draft preview carry the briefing", () => {
    const turno = ler("inbound-turn.ts");
    expect(turno).toContain("...(input.aberturaDoRascunho ? { aberturaExtra: input.aberturaDoRascunho } : {}),");
    expect(turno).toContain("...(preview.aberturaExtra ? [preview.aberturaExtra] : []),");
    expect(ler("reply-drafts.ts")).toContain(
      "...(input.aberturaExtra ? { aberturaExtra: input.aberturaExtra } : {}),",
    );
  });
});

describe("charge notice", () => {
  const LINK = "https://www.asaas.com/i/k7f2x9q1ab3c";
  const CHARGE: MiraeReminderPayload = {
    delivery_key: "charge_1:2026-11-25",
    reminder_id: "charge_1",
    delivery: "auto",
    kind: "charge_notice",
    title: "Cobrança da parcela 3/12",
    note: null,
    student_name: "Ana",
    appointment_start_at: null,
    professional_first_name: null,
    mirae_phone: "14996598955",
    charge: { link: LINK, due_date: "2026-11-25", amount_cents: 29900 },
  };
  const runCharge = (p: ReturnType<typeof ports>, r: MiraeReminderPayload = CHARGE) =>
    runMiraeReminderTurn(deps, job, {} as never, { workerId: "w" }, () => NOW, TARGET, r, p as never);

  it("formats the amount in BRL with a plain space and the due date as dd/mm", () => {
    expect(valorLegivel(29900)).toBe("R$ 299,00");
    expect(valorLegivel(1234567)).toBe("R$ 12.345,67");
    expect(vencimentoLegivel("2026-11-25")).toBe("25/11");
    expect(vencimentoLegivel("2027-01-05")).toBe("05/01");
  });

  it("the briefing carries the exact link, amount and due date, and forbids changing them", () => {
    const b = briefingDoLembrete(CHARGE, "America/Sao_Paulo");
    expect(b).toContain("## Cobrança do estúdio (Mirae)");
    expect(b).toContain(`- Link de pagamento: ${LINK}`);
    expect(b).toContain("- Valor: R$ 299,00");
    expect(b).toContain("- Vencimento: 25/11");
    expect(b).toContain("- Pessoa: Ana (primeiro nome)");
    expect(b).toContain("EXATAMENTE como estão acima");
    expect(b).toContain("não invente outro link");
    expect(b).toContain("nenhum dado clínico");
    expect(b).toContain("pediu para não");
    // Not a confirmation: no agenda read, no confirmation request.
    expect(b).not.toContain("mirae_my_appointments");
    expect(b).not.toContain("confirmar a presença");
    // No no-break space anywhere the model has to copy from.
    expect(b).not.toContain("\u00a0");
  });

  const SENT_OK = `Oi, Ana! A parcela de R$ 299,00 vence em 25/11. Link: ${LINK}`;

  it("auto: the agent's normal turn with the charge briefing, and Mirae's agenda is not read", async () => {
    const p = ports({ sentCharge: vi.fn(async () => [SENT_OK]) });
    await runCharge(p);
    expect(p.checkAppointment).not.toHaveBeenCalled();
    expect(p.generateReplyDraft).not.toHaveBeenCalled();
    expect(p.runAgentTurn).toHaveBeenCalledTimes(1);
    const input = (p.runAgentTurn.mock.calls[0] as unknown as [unknown, unknown, unknown, unknown, Record<string, unknown>])[4];
    const opening = (input.buildOpening as (r: unknown) => string)({
      previous: null,
      leadState: null,
      context: { contact: { name: "Ana", email: null }, messages: [] },
      notesIndexBlock: "sem notas",
      projeta: false,
    });
    expect(opening).toContain(LINK);
    expect(opening).toContain("R$ 299,00");
    expect(opening).toContain("25/11");
    expect(input.aberturaDoRascunho).toContain(LINK);
    expect(p.sentCharge).toHaveBeenCalledWith({}, { tenantId: "org", conversationId: "conv", link: LINK });
    expect(p.avisar).not.toHaveBeenCalled();
  });

  it("auto: a turn that sent nothing with the link (veto, opt-out, handoff, assisted) tells the team, with the charge", async () => {
    const p = ports({ sentCharge: vi.fn(async () => []) });
    await runCharge(p);
    expect(p.avisar).toHaveBeenCalledTimes(1);
    const aviso = (p.avisar.mock.calls[0] as unknown as [unknown, { reminder: MiraeReminderPayload; motivo: string }])[1];
    expect(aviso.reminder.charge?.link).toBe(LINK);
    expect(aviso.motivo).toContain("não enviou a cobrança");
  });

  it("auto: sent with the link but another amount or date tells the team", async () => {
    const p = ports({ sentCharge: vi.fn(async () => [`Oi! A parcela de R$ 290,00 vence em 25/11. ${LINK}`]) });
    await runCharge(p);
    expect(p.avisar).toHaveBeenCalledTimes(1);
    expect(
      (p.avisar.mock.calls[0] as unknown as [unknown, { motivo: string }])[1].motivo,
    ).toContain("sem o valor ou o vencimento exatos");
  });

  it("a turn deferred to the send window (it throws) does not tell the team yet", async () => {
    const p = ports({ runAgentTurn: vi.fn(async () => { throw new Error("job_settled"); }) });
    await expect(runCharge(p)).rejects.toThrow("job_settled");
    expect(p.sentCharge).not.toHaveBeenCalled();
    expect(p.avisar).not.toHaveBeenCalled();
  });

  it("trazValorEVencimento ignores spacing but not digits", () => {
    const charge = CHARGE.charge!;
    expect(trazValorEVencimento("R$299,00 até 25/11", charge)).toBe(true);
    expect(trazValorEVencimento("R$ 299,00 até 25/11", charge)).toBe(true);
    expect(trazValorEVencimento("R$ 299 até 25/11", charge)).toBe(false);
    expect(trazValorEVencimento("R$ 299,00 até 26/11", charge)).toBe(false);
  });

  it("sentChargeMessages reads outbound messages of the conversation that carry the link, by organization", async () => {
    const query = vi.fn(async () => ({ rows: [{ body: SENT_OK }] }));
    expect(await sentChargeMessages({ query } as never, { tenantId: "org", conversationId: "conv", link: LINK })).toEqual([
      SENT_OK,
    ]);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("organization_id = $1 and conversation_id = $2 and direction = 'outbound'");
    expect(sql).toContain("strpos(coalesce(body, ''), $3) > 0");
    expect(params).toEqual(["org", "conv", LINK]);
  });

  it("draft: an agent draft with the charge briefing", async () => {
    const p = ports({
      generateReplyDraft: vi.fn(async () => ({ id: "d", status: "pending", original_body: SENT_OK })),
    });
    await runCharge(p, { ...CHARGE, delivery: "draft" });
    expect(p.runAgentTurn).not.toHaveBeenCalled();
    const input = (p.generateReplyDraft.mock.calls[0] as unknown as [unknown, unknown, Record<string, unknown>])[2];
    expect(input.aberturaExtra).toContain(LINK);
    expect(p.avisar).not.toHaveBeenCalled();
  });

  it("draft: a draft already pending without the link (one draft per revision) tells the team", async () => {
    const p = ports({
      generateReplyDraft: vi.fn(async () => ({ id: "older", status: "pending", original_body: "Confirma a aula de amanhã?" })),
    });
    await runCharge(p, { ...CHARGE, delivery: "draft" });
    expect(p.avisar).toHaveBeenCalledTimes(1);
    expect((p.avisar.mock.calls[0] as unknown as [unknown, { motivo: string }])[1].motivo).toContain(
      "não traz o link da cobrança",
    );
  });

  it("the team's notice of a charge carries the link, the amount and the due date", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: "n" }] }));
    await avisarLembreteQueNaoSaiu({ query } as never, {
      tenantId: "org",
      conversationId: "conv",
      reminder: CHARGE,
      motivo: "Motivo.",
    });
    const params = (query.mock.calls[0] as unknown as [string, unknown[]])[1];
    const body = params.find((v) => typeof v === "string" && v.startsWith("Motivo.")) as string;
    expect(body).toContain(LINK);
    expect(body).toContain("R$ 299,00");
    expect(body).toContain("25/11");
  });

  it("a charge notice that lost its charge data is never sent as a generic message", async () => {
    const p = ports();
    await runCharge(p, { ...CHARGE, charge: null });
    expect(p.runAgentTurn).not.toHaveBeenCalled();
    expect(p.generateReplyDraft).not.toHaveBeenCalled();
    expect(p.avisar).toHaveBeenCalledTimes(1);
  });

  it("the payload round-trips through the worker's reader", () => {
    expect(lembreteDoMirae({ source: "mirae_reminder", mirae_reminder: CHARGE })).toEqual(CHARGE);
    expect(
      lembreteDoMirae({ source: "mirae_reminder", mirae_reminder: { ...CHARGE, charge: { ...CHARGE.charge, amount_cents: 0 } } }),
    ).toBeNull();
  });

  describe("spinning guard (default knobs)", () => {
    // Same plan, same due date: what the agent writes to each student differs only in the name
    // and the link, so the copies are near-identical across the studio's number.
    // Starts with the name: a template literal's static prefix counts as on-screen text for the
    // course fence (`curso/licoes-apontam-para-a-tela.test.ts`), and "Oi, " would match lessons.
    const message = (name: string, link: string) =>
      `${name}, tudo bem? Aqui é do estúdio. A cobrança da próxima parcela do seu plano já está ` +
      `disponível: R$ 299,00, com vencimento em 25/11. Para pagar é só acessar o link: ${link} ` +
      "Qualquer dúvida, estamos por aqui!";
    const windowOf = (texts: string[]) =>
      texts.map((t) => {
        const normalizedText = normalizeCopy(t);
        return { normalizedText, normalizedHash: hashNormalized(normalizedText) };
      });
    const sent = windowOf([
      message("Ana", "https://www.asaas.com/i/aaaa1111"),
      message("Bia", "https://www.asaas.com/i/bbbb2222"),
      message("Carla", "https://www.asaas.com/i/cccc3333"),
    ]);

    it("does not veto a charge notice with the Asaas link", () => {
      expect(
        decideSpinning({
          candidate: message("Dani", "https://www.asaas.com/i/dddd4444"),
          window: sent,
          knobs: SPINNING_DEFAULTS,
        }),
      ).toEqual({ allow: true });
      expect(
        decideSpinning({
          candidate: message("Dani", "https://sandbox.asaas.com/i/dddd4444"),
          window: sent,
          knobs: SPINNING_DEFAULTS,
        }).allow,
      ).toBe(true);
    });

    it("control: the same copy with a link on another host is vetoed (the exemption is the Asaas host)", () => {
      const other = windowOf([
        message("Ana", "https://example.com/i/aaaa1111"),
        message("Bia", "https://example.com/i/bbbb2222"),
      ]);
      expect(
        decideSpinning({
          candidate: message("Dani", "https://example.com/i/dddd4444"),
          window: other,
          knobs: SPINNING_DEFAULTS,
        }).allow,
      ).toBe(false);
      expect(
        decideSpinning({
          candidate: message("Dani", "https://www.asaas.com.evil.example/i/dddd4444"),
          window: other,
          knobs: SPINNING_DEFAULTS,
        }).allow,
      ).toBe(false);
    });
  });
});
