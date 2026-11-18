// @vitest-environment node
/**
 * Berseba: what Mirae's agenda answered (booking, the person's appointments, free slots, plans
 * and rules) is evidence for the promise reviewer, so a booking confirmation, an offered slot or
 * a plan price is not vetoed as an unbacked promise. Only a successful server result counts.
 */
import { describe, expect, it } from "vitest";

import {
  FERRAMENTAS_DE_AGENDA_DO_AVEC,
  FERRAMENTAS_DE_AGENDA_DO_MIRAE,
  FERRAMENTAS_QUE_VIRAM_EVIDENCIA,
  evidenciasDaAgenda,
} from "./evidencia-de-agenda.berseba";
import { criarEvidenciasComerciaisDoTurno } from "./evidencias-comerciais";

// Shapes as `lib/mcp/tools/mirae.ts` returns them (bookedView, appointmentView, opcaoView).
const AGENDAMENTO = {
  appointment_id: "apt-1",
  servico: "avaliação inicial",
  dia_semana: "quarta-feira",
  data_br: "18/11",
  inicio: "09:00",
  termina: "10:00",
  profissional: "Raquel",
};
const BOOK = { ok: true, agendamento: AGENDAMENTO };
const MINE = {
  ok: true,
  pessoa: { primeiro_nome: "Ana", etapa: "lead" },
  agendamentos: [
    { ...AGENDAMENTO, data: "2026-11-18", status: "scheduled", pode_mudar: true },
    { ...AGENDAMENTO, appointment_id: "apt-2", servico: "aula", data_br: "20/11", data: "2026-11-20", status: "scheduled", pode_mudar: true },
  ],
};
const SLOTS = {
  ok: true,
  opcoes: [
    { opcao_id: "eyJ...", dia_semana: "terça-feira", data: "2026-11-24", data_br: "24/11", inicio: "09:00", termina: "10:00", profissional: "Raquel", vagas: 2 },
    { opcao_id: "eyK...", dia_semana: "terça-feira", data: "2026-11-24", data_br: "24/11", inicio: "18:00", termina: "19:00", profissional: "Andressa" },
  ],
};
const SERVICES = {
  ok: true,
  servicos: ["avaliacao", "aula"],
  planos: [
    { nome: "2x por semana mensal", valor_br: "R$ 320,00", aulas_por_semana: 2 },
    { nome: "2x por semana semestral", valor_br: "R$ 1.680,00", meses: 6, por_mes_br: "R$ 280,00", aulas_por_semana: 2 },
    { nome: "sem valor" },
  ],
  regras: { antecedencia_minima_horas: 2, agenda_aberta_dias: 30, remarcar_ou_cancelar_ate_horas_antes: 4 },
};

describe("Mirae results as evidence", () => {
  it("the tool sets: the five Mirae tools join avec's, and mirae_cancel is not one", () => {
    expect([...FERRAMENTAS_DE_AGENDA_DO_MIRAE].sort()).toEqual([
      "mirae_book",
      "mirae_free_slots",
      "mirae_my_appointments",
      "mirae_reschedule",
      "mirae_services",
    ]);
    for (const t of [...FERRAMENTAS_DE_AGENDA_DO_AVEC, ...FERRAMENTAS_DE_AGENDA_DO_MIRAE]) {
      expect(FERRAMENTAS_QUE_VIRAM_EVIDENCIA.has(t)).toBe(true);
    }
    expect(FERRAMENTAS_QUE_VIRAM_EVIDENCIA.has("mirae_cancel")).toBe(false);
  });

  it("mirae_book: the booking written in the studio's agenda", () => {
    const [e, ...resto] = evidenciasDaAgenda("mirae_book", BOOK);
    expect(resto).toEqual([]);
    expect(e!.origem).toBe("agenda");
    expect(e!.titulo).toContain("gravado na agenda do estúdio");
    expect(JSON.parse(e!.conteudo)).toEqual({
      fonte: "agenda do estúdio (Mirae)",
      servico: "avaliação inicial",
      dia_semana: "quarta-feira",
      data: "18/11",
      inicio: "09:00",
      termina: "10:00",
      profissional: "Raquel",
    });
  });

  it("mirae_reschedule: the new time", () => {
    const [e] = evidenciasDaAgenda("mirae_reschedule", { ...BOOK, aviso: "o appointment_id pode ter mudado" });
    expect(e!.titulo).toContain("remarcado");
  });

  it("mirae_my_appointments: one piece of evidence per appointment, with its status", () => {
    const lidas = evidenciasDaAgenda("mirae_my_appointments", MINE);
    expect(lidas).toHaveLength(2);
    expect(new Set(lidas.map((e) => e.referencia)).size).toBe(2);
    expect(JSON.parse(lidas[0]!.conteudo).situacao).toBe("scheduled");
  });

  it("mirae_free_slots: offered slots are availability, never a booking", () => {
    const lidas = evidenciasDaAgenda("mirae_free_slots", SLOTS);
    expect(lidas).toHaveLength(2);
    expect(lidas[0]!.titulo).toContain("ainda não reservado");
    expect(JSON.parse(lidas[0]!.conteudo)).toMatchObject({
      situacao: "livre, ainda não reservado",
      data: "24/11",
      inicio: "09:00",
      profissional: "Raquel",
      vagas: 2,
    });
    // The signed option id is for the tool, not for the reviewer.
    expect(lidas[0]!.conteudo).not.toContain("opcao_id");
  });

  it("mirae_services: each priced plan is catalog evidence, the rules are policy", () => {
    const lidas = evidenciasDaAgenda("mirae_services", SERVICES);
    const planos = lidas.filter((e) => e.origem === "catalogo");
    expect(planos).toHaveLength(2);
    expect(JSON.parse(planos[1]!.conteudo)).toEqual({
      fonte: "agenda do estúdio (Mirae)",
      nome: "2x por semana semestral",
      valor_total: "R$ 1.680,00",
      meses: 6,
      por_mes: "R$ 280,00",
      aulas_por_semana: 2,
    });
    const [regras] = lidas.filter((e) => e.origem === "conhecimento");
    expect(JSON.parse(regras!.conteudo)).toMatchObject({ remarcar_ou_cancelar_ate_horas_antes: 4 });
  });

  it("a failed, partial or malformed result is never evidence", () => {
    for (const t of FERRAMENTAS_DE_AGENDA_DO_MIRAE) {
      expect(evidenciasDaAgenda(t, { ok: false, handoff: true, mensagem: "x" })).toEqual([]);
      expect(evidenciasDaAgenda(t, null)).toEqual([]);
      expect(evidenciasDaAgenda(t, { error: "boom" })).toEqual([]);
    }
    expect(evidenciasDaAgenda("mirae_book", { ok: true, agendamento: { servico: "aula" } })).toEqual([]);
    expect(evidenciasDaAgenda("mirae_free_slots", { ok: true, opcoes: "x" })).toEqual([]);
    expect(evidenciasDaAgenda("mirae_cancel", { ok: true, appointment_id: "a", status: "cancelled" })).toEqual([]);
  });

  it("reaches the reviewer through the turn's store", () => {
    const store = criarEvidenciasComerciaisDoTurno([]);
    store.registrarAgendamento("mirae_book", BOOK);
    store.registrarAgendamento("mirae_services", SERVICES);
    const lidas = store.ler("Prontinho! Sua avaliação está marcada para quarta, 18/11, às 9h com a Raquel.");
    expect(lidas.some((e) => e.origem === "agenda" && e.conteudo.includes("18/11"))).toBe(true);
    expect(lidas.some((e) => e.origem === "catalogo")).toBe(true);
  });
});
