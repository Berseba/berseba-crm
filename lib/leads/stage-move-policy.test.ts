import { describe, expect, it } from "vitest";

import { decideStageMove } from "./stage-move-policy";

/**
 * Os quatro casos do contrato: o knob decide entre auto/suggest para etapa
 * ATIVA, e a etapa TERMINAL (is_won/is_lost) vence o knob sempre — mesmo
 * "auto" nunca move um negócio para dentro do desfecho sozinho.
 */
describe("decideStageMove", () => {
  it("auto + etapa ativa → move (nível 1, automático)", () => {
    expect(
      decideStageMove({ mode: "auto", targetStage: { is_won: false, is_lost: false } }),
    ).toEqual({ action: "move", reason: "auto" });
  });

  it("auto + etapa GANHOU → sugere (regra dura vence o knob)", () => {
    expect(
      decideStageMove({ mode: "auto", targetStage: { is_won: true, is_lost: false } }),
    ).toEqual({ action: "suggest", reason: "terminal_stage" });
  });

  it("suggest + etapa ativa → sugere (nível 2, IA sugere/humano confirma)", () => {
    expect(
      decideStageMove({ mode: "suggest", targetStage: { is_won: false, is_lost: false } }),
    ).toEqual({ action: "suggest", reason: "suggest_mode" });
  });

  it("suggest + etapa PERDEU → sugere, e o motivo é o terminal, não o modo", () => {
    // A regra dura vence mesmo quando o knob JÁ mandaria sugerir — o `reason`
    // precisa nomear a causa VERDADEIRA (fechamento de negócio), não a
    // primeira que bateria.
    expect(
      decideStageMove({ mode: "suggest", targetStage: { is_won: false, is_lost: true } }),
    ).toEqual({ action: "suggest", reason: "terminal_stage" });
  });
});
