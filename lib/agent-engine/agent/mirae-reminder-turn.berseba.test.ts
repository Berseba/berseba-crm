// @vitest-environment node
/**
 * Berseba: the agent turn of a Mirae reminder. A draft goes to the inbox whatever the agent's
 * mode; an automatic one goes through the normal turn (send window, gate); the briefing is
 * orientation, never the message; a reminder that would arrive too late is dropped.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  briefingDoLembrete,
  chegaTardeDemais,
  lembreteDoMirae,
  quandoLegivel,
  runMiraeReminderTurn,
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
const job = { id: "job-1", organization_id: "org", contact_id: "contact", kind: "followup_turn", payload: {} } as never;

function ports(over: Record<string, unknown> = {}) {
  return {
    runAgentTurn: vi.fn(async () => undefined),
    generateReplyDraft: vi.fn(async () => ({ id: "draft-1", status: "pending" })),
    fuso: vi.fn(async () => "America/Sao_Paulo"),
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

  it("too close to the appointment: nothing runs", async () => {
    const p = ports();
    await runMiraeReminderTurn(deps, job, {} as never, { workerId: "w" }, () => new Date("2026-11-18T11:30:00.000Z"), TARGET, REMINDER, p as never);
    expect(p.runAgentTurn).not.toHaveBeenCalled();
    expect(p.generateReplyDraft).not.toHaveBeenCalled();
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
