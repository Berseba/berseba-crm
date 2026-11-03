/**
 * Berseba: the promise reviewer sees the booking the server just wrote, and a
 * reply turn it silenced goes to the team.
 *
 * Salão Mayara Morales, 30/10: the client said "Sim", `avec_book` wrote the
 * visit, and the semantic promise layer vetoed "Prontinho, seu horário está
 * marcado…" five times as a slot confirmed without proof. Nothing was sent and
 * nobody was told.
 *
 * The turn wiring sits in the middle of the turn closure, with no cheap
 * injection point, so it is pinned as a source contract (same technique as
 * `correcao-do-turno-mudo-so-escala-com-falha.test.ts`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { turnoCaladoPorVetoPedePassagem } from "@/lib/agent-engine/agent/turno-calado-por-veto.berseba";
import {
  FERRAMENTAS_QUE_GRAVAM_NO_AVEC,
  evidenciaDoAgendamento,
} from "@/lib/agent-engine/guardrails/promise/evidencia-de-agenda.berseba";
import { criarEvidenciasComerciaisDoTurno } from "@/lib/agent-engine/guardrails/promise/evidencias-comerciais";

const RESULTADO_DO_BOOK = {
  ok: true,
  agendamento: {
    servico: "Design de sobrancelha",
    dia_semana: "sábado",
    data: "2026-11-07",
    data_br: "07/11/2026",
    inicio: "14:30",
    termina_por_volta_de: "15:00",
    profissional: "Rebeca",
    status: "Agendado",
  },
  etapas: [],
};

const RESULTADO_DO_RESCHEDULE = {
  ok: true,
  agendamento: {
    appointment_id: "a-2",
    service: "Corte",
    professional: "Eliton",
    weekday: "quarta-feira",
    date: "2026-11-04",
    start_time: "16:00",
    data_br: "04/11/2026",
  },
  aviso: "o appointment_id pode ter mudado: use o deste resultado daqui em diante.",
};

describe("evidenciaDoAgendamento", () => {
  it("a successful avec_book becomes agenda evidence with the visit", () => {
    const e = evidenciaDoAgendamento("avec_book", RESULTADO_DO_BOOK);
    expect(e).not.toBeNull();
    expect(e!.origem).toBe("agenda");
    expect(e!.referencia).toBe("avec_book:07/11/2026:14:30");
    expect(JSON.parse(e!.conteudo)).toEqual({
      situacao: "confirmado pelo sistema de agenda",
      servico: "Design de sobrancelha",
      dia_semana: "sábado",
      data: "07/11/2026",
      inicio: "14:30",
      profissional: "Rebeca",
    });
  });

  it("a successful avec_reschedule reads the appointment view fields", () => {
    const e = evidenciaDoAgendamento("avec_reschedule", RESULTADO_DO_RESCHEDULE);
    expect(e!.titulo).toContain("remarcado");
    expect(JSON.parse(e!.conteudo)).toMatchObject({
      servico: "Corte",
      dia_semana: "quarta-feira",
      data: "04/11/2026",
      inicio: "16:00",
      profissional: "Eliton",
    });
  });

  it("a failed or partial write is never evidence", () => {
    expect(evidenciaDoAgendamento("avec_book", { ok: false, mensagem: "x" })).toBeNull();
    expect(
      evidenciaDoAgendamento("avec_book", { ok: false, parcial: true, handoff: true }),
    ).toBeNull();
    expect(evidenciaDoAgendamento("avec_book", { error: "boom" })).toBeNull();
    expect(evidenciaDoAgendamento("avec_book", null)).toBeNull();
  });

  it("needs the day and the hour, and only avec write tools count", () => {
    expect(
      evidenciaDoAgendamento("avec_book", { ok: true, agendamento: { servico: "Corte" } }),
    ).toBeNull();
    expect(evidenciaDoAgendamento("avec_free_slots", RESULTADO_DO_BOOK)).toBeNull();
    expect(evidenciaDoAgendamento("avec_cancel", RESULTADO_DO_BOOK)).toBeNull();
    expect([...FERRAMENTAS_QUE_GRAVAM_NO_AVEC].sort()).toEqual(["avec_book", "avec_reschedule"]);
  });
});

describe("the turn's evidence store", () => {
  it("the booking reaches the reviewer even when knowledge fills the package", () => {
    const fonte = "11111111-1111-1111-1111-111111111111";
    const store = criarEvidenciasComerciaisDoTurno([fonte]);
    store.registrarConhecimento({
      results: Array.from({ length: 40 }, (_, i) => ({
        knowledge_source_id: fonte,
        chunk_id: `c${i}`,
        source_name: "Serviços",
        content: `Prontinho, horário marcado para o serviço ${i}, com a profissional do salão.`,
      })),
    });
    store.registrarAgendamento("avec_book", RESULTADO_DO_BOOK);
    const lidas = store.ler("Prontinho! Seu horário está marcado para sábado, 07/11, às 14h30.");
    expect(lidas.filter((e) => e.origem === "agenda")).toHaveLength(1);
  });

  it("a failed write adds nothing", () => {
    const store = criarEvidenciasComerciaisDoTurno([]);
    store.registrarAgendamento("avec_book", { ok: false });
    expect(store.ler("Prontinho")).toEqual([]);
  });
});

describe("turnoCaladoPorVetoPedePassagem", () => {
  const base = {
    preview: false,
    turnoDeResposta: true,
    enviadas: 0,
    vetosDePromessa: 5,
    turnoDescartado: false,
    passouParaAEquipe: false,
    capDeEnvio: false,
  };

  it("a reply turn silenced by promise vetoes goes to the team", () => {
    expect(turnoCaladoPorVetoPedePassagem(base)).toBe(true);
  });

  it("any message out, or no promise veto, keeps the turn as it is", () => {
    expect(turnoCaladoPorVetoPedePassagem({ ...base, enviadas: 1 })).toBe(false);
    expect(turnoCaladoPorVetoPedePassagem({ ...base, vetosDePromessa: 0 })).toBe(false);
  });

  it("legitimate silences are exempt", () => {
    expect(turnoCaladoPorVetoPedePassagem({ ...base, preview: true })).toBe(false);
    expect(turnoCaladoPorVetoPedePassagem({ ...base, turnoDeResposta: false })).toBe(false);
    expect(turnoCaladoPorVetoPedePassagem({ ...base, turnoDescartado: true })).toBe(false);
    expect(turnoCaladoPorVetoPedePassagem({ ...base, passouParaAEquipe: true })).toBe(false);
    expect(turnoCaladoPorVetoPedePassagem({ ...base, capDeEnvio: true })).toBe(false);
  });
});

describe("turn wiring (source contract)", () => {
  const turno = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");

  it("avec write results are registered as evidence after the server answers", () => {
    const i = turno.indexOf("FERRAMENTAS_QUE_GRAVAM_NO_AVEC.has(name)");
    expect(i).toBeGreaterThan(-1);
    const bloco = turno.slice(i, i + 700);
    expect(bloco).toContain("const resultado = await executeOriginal(...args);");
    expect(bloco).toContain("evidenciasComerciais.registrarAgendamento(name, resultado);");
  });

  it("promise vetoes are counted where every veto returns to the model", () => {
    expect(turno).toContain("if (chain.code === 'promise_semantic') vetosDePromessa += 1;");
  });

  it("the handoff runs after the script question and before the closing call", () => {
    const iRoteiro = turno.indexOf("ROTEIRO: a pergunta pendente");
    const iPassagem = turno.indexOf("turnoCaladoPorVetoPedePassagem({");
    const iFechamento = turno.indexOf("F3-10: poda os tool results antigos");
    expect(iRoteiro).toBeGreaterThan(-1);
    expect(iPassagem).toBeGreaterThan(iRoteiro);
    expect(iFechamento).toBeGreaterThan(iPassagem);
    const bloco = turno.slice(iPassagem, iFechamento);
    expect(bloco).toContain("enviadas: outcomes.length + seq,");
    expect(bloco).toContain("passouParaAEquipe = true;");
    expect(bloco).toContain("motivo: 'outro',");
    expect(bloco).toContain("motivo_codigo: 'critical_stage', por_que: POR_QUE_DO_TURNO_CALADO");
  });
});
