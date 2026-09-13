/**
 * FREIO CLÍNICO 2 — nunca diagnóstico, nunca prescrição.
 *
 * Corpus de veto + corpus de controle (falso positivo), mesma disciplina do
 * `handoff-g4-medical.test.ts` e do `opt-out-deteccao.test.ts`: "avaliação",
 * "sessão", "exercício" são o vocabulário do dia a dia da clínica e não podem
 * disparar o veto.
 */
import { describe, expect, it } from "vitest";

import {
  detectarEscopoClinicoIndevido,
  renderVetoDeEscopoClinico,
} from "@/lib/agent-engine/guardrails/escopo-clinico";
import { clinicalScopeGate, type GateContext } from "@/lib/agent-engine/guardrails/before-send";

/** Respostas que o assistente NUNCA pode mandar — todas devem vetar. */
const VETA = [
  "Você tem tendinite no ombro.",
  "Você está com uma hérnia de disco.",
  "Isso é bursite mesmo.",
  "Seu problema é a postura no trabalho.",
  "Seu diagnóstico é escoliose leve.",
  "Tome 2 comprimidos de ibuprofeno de 8 em 8 horas.",
  "Use dipirona se a dor voltar.",
  "Pode tomar 600mg de ibuprofeno agora.",
  "Recomendo tomar um analgésico antes da sessão.",
  "Isso vai curar rapidinho.",
  "Garantimos que a dor some em uma semana.",
  "Temos garantia de cura para esse quadro.",
];

/** Respostas legítimas de uma clínica — nenhuma pode vetar. */
const PERMITE = [
  "A avaliação com o fisioterapeuta vai identificar o que está acontecendo.",
  "Cada caso é avaliado presencialmente antes de qualquer indicação.",
  "Podemos agendar uma sessão de avaliação para o profissional te examinar.",
  "O exercício que você fez hoje é só parte do protocolo.",
  "Nossos preços de sessão avulsa e pacote estão na tabela que te mandei.",
  "Use uma roupa confortável para a sessão de pilates.",
  "Tome cuidado ao descer da maca, pode escorregar.",
  "Vamos marcar sua sessão de retorno para a próxima semana.",
  "Você tem razão, esse horário não fecha — vou verificar outro.",
  "Você tem que trazer o encaminhamento médico na primeira sessão.",
  "",
  "   ",
];

/**
 * Vocabulário típico de clínica DITO PELO CONTATO (paciente), não pela IA —
 * "problema", "avaliação", "exercício", "condição", "diagnóstico" no
 * vocabulário cotidiano de quem procura fisioterapia/pilates. O gate de SAÍDA
 * só inspeciona `ctx.body`, que é sempre o texto que o MODELO vai enviar
 * (`RunBeforeSendArgs.body`, `before-send.ts`) — a mensagem do contato nunca
 * chega a `detectarEscopoClinicoIndevido`. Estas frases entram no corpus de
 * controle mesmo assim, como STRINGS ISOLADAS, para provar que o vocabulário
 * do dia a dia do paciente — que a IA legitimamente ecoa ao reformular o que
 * ele disse ("entendi, você mencionou um problema na coluna") — não teria
 * como acionar o veto mesmo se aparecesse dentro da resposta do assistente.
 * Continuação do endurecimento de falso positivo do regex de diagnóstico
 * (`DIAGNOSIS_PATTERN` em `escopo-clinico.ts`), ancorado em 2ª pessoa
 * presente ("você tem"/"isso é"/"seu problema é") — nenhuma destas frases,
 * em 1ª pessoa ou tempo verbal diferente, casa com esse padrão.
 */
const PERMITE_VOCABULARIO_DO_PACIENTE = [
  "problema na coluna",
  "avaliação postural",
  "exercício para o joelho",
  "tenho uma condição no ombro",
  "meu diagnóstico foi hérnia",
];

describe("detectarEscopoClinicoIndevido — freio clínico 2", () => {
  it.each(VETA)("veta: %s", (texto) => {
    const achado = detectarEscopoClinicoIndevido(texto);
    expect(achado.achou, `deveria vetar: "${texto}"`).toBe(true);
    expect(achado.categorias.length).toBeGreaterThan(0);
  });

  it.each(PERMITE)("permite: %s — controle de falso positivo", (texto) => {
    expect(detectarEscopoClinicoIndevido(texto).achou, `não deveria vetar: "${texto}"`).toBe(
      false,
    );
  });

  it.each(PERMITE_VOCABULARIO_DO_PACIENTE)(
    "permite: %s — vocabulário do PACIENTE, nunca vetável mesmo ecoado pela IA",
    (texto) => {
      expect(detectarEscopoClinicoIndevido(texto).achou, `não deveria vetar: "${texto}"`).toBe(
        false,
      );
    },
  );

  it("renderVetoDeEscopoClinico nomeia a categoria detectada", () => {
    const texto = renderVetoDeEscopoClinico(["diagnostico"]);
    expect(texto).toMatch(/diagn[oó]stico/i);
    expect(texto.length).toBeGreaterThan(30);
  });
});

/** Um GateContext mínimo, com o resto no-op — só o que `clinicalScopeGate` lê. */
function ctxComCorpo(body: string, nichoSaude: boolean): GateContext {
  return {
    now: new Date(),
    body,
    optedOut: false,
    provider: "waha",
    pacing: { knobs: {} as never, state: {} as never, crmDailyLimit: null },
    spinning: { knobs: {} as never, window: [] },
    promise: { table: null },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
    lgpd: null,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    nichoSaude,
  };
}

describe("clinicalScopeGate — o gate em `before-send.ts`", () => {
  it("nicho !== saude: no-op mesmo com diagnóstico na candidata", () => {
    const veredito = clinicalScopeGate.evaluate(ctxComCorpo("Você tem tendinite.", false));
    expect(veredito.pass).toBe(true);
  });

  it("nicho === saude: veta diagnóstico", () => {
    const veredito = clinicalScopeGate.evaluate(ctxComCorpo("Você tem tendinite.", true));
    expect(veredito.pass).toBe(false);
    if (!veredito.pass) {
      expect(veredito.code).toBe("clinical_scope_violation");
      expect(veredito.reason.length).toBeGreaterThan(10);
    }
  });

  it("nicho === saude: passa mensagem sem diagnóstico/prescrição/promessa", () => {
    const veredito = clinicalScopeGate.evaluate(
      ctxComCorpo("A avaliação com o fisioterapeuta vai identificar o que está acontecendo.", true),
    );
    expect(veredito.pass).toBe(true);
  });
});
