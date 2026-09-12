/**
 * FREIO CLÍNICO 1 — a calibração do G4_MEDICAL, congelada.
 *
 * Mesma disciplina de `tests/unit/opt-out-deteccao.test.ts`: duas listas, e o
 * controle de falso positivo é o que mais importa. Dor crônica é o cliente
 * típico de uma clínica de fisioterapia/pilates — uma regra que dispara em
 * "dor" solta inutiliza o produto (é a mesma lição que o `stop_keyword`
 * aprendeu com "tem como parar a dor?").
 */
import { describe, expect, it } from "vitest";

import { checkG4Medical } from "@/lib/ai/handoff/triggers";

/** Frases que PRECISAM disparar o handoff de urgência médica (PT-BR). */
const URGENCIA_MEDICA_PT = [
  "estou com dor no peito",
  "sinto uma dor no peito forte",
  "acho que é um infarto",
  "estou com dor torácica desde ontem",
  "não consigo respirar direito",
  "estou com falta de ar",
  "tenho dificuldade para respirar agora",
  "eu desmaiei agora há pouco",
  "minha mãe desmaiou",
  "o corte não para de sangrar",
  "está com hemorragia",
  "acho que ele teve um avc",
  "acho que foi um derrame",
  "o rosto dela ficou todo torto",
  "a boca dele ficou torta de repente",
  "a fala dele ficou toda enrolada",
  "ele teve uma convulsão agora",
  "quebrou o braço e ficou com fratura exposta",
  "acho que foi overdose",
  "eu quero morrer",
  "eu quero me matar",
  "estou tendo pensamentos suicidas",
  "não aguento mais viver",
  "ele caiu e bateu a cabeça",
  "teve uma queda feia e bateu com a cabeça",
  "estou com uma dor de cabeça súbita e muito forte",
  "essa é a pior dor de cabeça da minha vida",
  "meu bebê está com febre alta",
  "a febre do bebê está muito alta",
];

/** Frases equivalentes em espanhol — mesma paridade que o opt-out exige. */
const URGENCIA_MEDICA_ES = [
  "tengo dolor en el pecho",
  "creo que es un ataque cardiaco",
  "tengo dolor toracico",
  "no puedo respirar",
  "mi papa se desmayo",
  "tiene un sangrado que no para",
  "creo que tuvo un acv",
  "tiene la cara torcida",
  "tiene el habla enredada",
  "tuvo una convulsion",
  "tiene una fractura expuesta",
  "creo que fue una sobredosis",
  "quiero morir",
  "me quiero matar",
  "tengo pensamientos suicidas",
  "se cayo y se golpeo la cabeza",
  "tengo un dolor de cabeza subito y muy fuerte",
  "es el peor dolor de cabeza de mi vida",
  "mi bebe tiene fiebre alta",
];

/** Frases do dia a dia de clínica que NÃO podem disparar — o controle. */
const NAO_E_URGENCIA_MEDICA = [
  // derrame ARTICULAR é ortopedia, não AVC — falso positivo real de clínica
  "tenho derrame no joelho desde a cirurgia",
  "o médico disse que é derrame articular",
  "derrame sinovial no tornozelo, dá pra fazer fisio?",
  "tem como parar a dor?",
  "dor nas costas há meses",
  "dor no ombro depois do treino",
  "quero morrer de rir",
  "dor de cabeça leve",
  "meu peito está mais forte depois do pilates",
  "dor no joelho quando agacho",
  "estou com dor lombar crônica",
  "posso fazer o exercício mesmo com dor?",
  "a dor piorou um pouco depois da sessão",
  "quero morrer de vergonha desse look",
  "estou com uma dorzinha de cabeça",
  "meu filho está gripado",
  "meu bebê está com febre baixa",
  "vou desmaiar de tanto rir com esse vídeo",
  "",
  "   ",
];

describe("checkG4Medical — freio clínico 1 (urgência médica)", () => {
  it.each(URGENCIA_MEDICA_PT)("dispara para %s", (texto) => {
    expect(checkG4Medical(texto)).toBe(true);
  });

  it.each(URGENCIA_MEDICA_ES)("dispara para %s (espanhol)", (texto) => {
    expect(checkG4Medical(texto)).toBe(true);
  });

  it.each(NAO_E_URGENCIA_MEDICA)("NÃO dispara para %s — controle de falso positivo", (texto) => {
    expect(checkG4Medical(texto)).toBe(false);
  });

  it("é robusto a maiúsculas e falta de acento — quem escreve em pânico não acentua", () => {
    expect(checkG4Medical("NAO CONSIGO RESPIRAR")).toBe(true);
    expect(checkG4Medical("estou com dor toracica")).toBe(true);
    expect(checkG4Medical("ele teve uma convulsao")).toBe(true);
  });
});
