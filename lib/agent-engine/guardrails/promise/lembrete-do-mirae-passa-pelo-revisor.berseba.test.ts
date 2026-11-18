// @vitest-environment node
/**
 * Berseba: the Mirae reminder the agent writes ("Sua avaliação é amanhã, quarta 18/11 às 9h com a
 * Raquel, confirma?") reaches the promise reviewer WITH the appointment it repeats, so the
 * semantic_promise layer has the proof and does not veto it as an invented slot. The briefing
 * makes the agent call `mirae_my_appointments` before writing (`mirae-reminder-turn.berseba.ts`),
 * and that result is what the turn's evidence store holds. The reviewer's model is a seam here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../../edge/llm/run-model-call", () => ({ runModelCall: seam.call }));

import type pg from "pg";

import { briefingDoLembrete } from "../../agent/mirae-reminder-turn.berseba";
import type { LlmEdgeConfig } from "../../edge/llm/run-model-call";
import { criarEvidenciasComerciaisDoTurno } from "./evidencias-comerciais";
import { classifyPromise } from "./semantic";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// `mirae_my_appointments` as `lib/mcp/tools/mirae.ts` returns it.
const MINHAS = {
  ok: true,
  pessoa: { primeiro_nome: "Ana", etapa: "lead" },
  agendamentos: [
    {
      appointment_id: "apt-1",
      servico: "avaliação inicial",
      dia_semana: "quarta-feira",
      data: "2026-11-18",
      data_br: "18/11",
      inicio: "09:00",
      termina: "10:00",
      profissional: "Raquel",
      status: "scheduled",
      pode_mudar: true,
    },
  ],
};
const LEMBRETE =
  "Oi, Ana! Passando para lembrar da sua avaliação inicial amanhã, quarta-feira, 18/11, às 09:00 com a Raquel. Você confirma?";

beforeEach(() => {
  seam.call.mockReset();
  seam.call.mockResolvedValue({ result: { text: '{"isPromise":false,"suspectPhrase":null}' } });
});

describe("a Mirae reminder through the promise reviewer", () => {
  it("the briefing always asks for the read that becomes the proof", () => {
    const b = briefingDoLembrete(
      {
        delivery_key: "k",
        reminder_id: "r",
        delivery: "auto",
        kind: "evaluation_confirmation",
        title: "Confirmar avaliação",
        note: null,
        student_name: "Ana",
        appointment_start_at: "2026-11-18T12:00:00.000Z",
        professional_first_name: "Raquel",
      },
      "America/Sao_Paulo",
      "confirmed",
    );
    expect(b).toContain("chame mirae_my_appointments");
  });

  it("the reviewer receives the appointment the reminder repeats, as agenda evidence", async () => {
    const store = criarEvidenciasComerciaisDoTurno([]);
    store.registrarAgendamento("mirae_my_appointments", MINHAS);
    const evidencias = store.ler(LEMBRETE);

    const result = await classifyPromise(
      {} as pg.Pool,
      {} as LlmEdgeConfig,
      { tenantId: "org" },
      { candidate: LEMBRETE, commercialEvidence: evidencias },
      { log },
    );

    const request = seam.call.mock.calls[0]?.[2];
    if (!request) throw new Error("the reviewer was not called");
    const payload = JSON.parse(request.messages[0].content);
    expect(payload.mensagem ?? request.messages[0].content).toContain("18/11");
    const agenda = (payload.evidencias as Array<{ origem: string; conteudo: string }>).filter(
      (e) => e.origem === "agenda",
    );
    expect(agenda).toHaveLength(1);
    expect(JSON.parse(agenda[0]!.conteudo)).toMatchObject({
      fonte: "agenda do estúdio (Mirae)",
      situacao: "scheduled",
      servico: "avaliação inicial",
      dia_semana: "quarta-feira",
      data: "18/11",
      inicio: "09:00",
      profissional: "Raquel",
    });
    expect(result).toMatchObject({ isPromise: false });
  });

  it("without the read there is nothing to prove it (why the briefing insists)", () => {
    expect(criarEvidenciasComerciaisDoTurno([]).ler(LEMBRETE)).toEqual([]);
  });
});
