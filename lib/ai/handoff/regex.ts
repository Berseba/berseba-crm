/**
 * Regex + heuristics used by the handoff orchestrator (EPIC-06 wave 3).
 *
 * G1 — pedido humano explícito (PT-BR).
 * G4 — menção a termos jurídicos / regulatórios.
 * G4_MEDICAL — urgência médica relatada pelo contato (freio clínico 1, opt-in por
 * nicho='saude' — ver `lib/agent-engine/guardrails/camadas-da-org.ts`).
 * UNCERTAINTY — frases que sinalizam que o bot não tem confiança na resposta.
 *
 * Estes são heurísticos puros (regex / string matching). Mudanças aqui
 * impactam diretamente a taxa de handoff — toque com testes.
 */

export const G1_REGEX =
  /\b(quero|preciso|posso)\s+(falar|conversar|atendimento|atendente|humano|pessoa|gente|alguem|alguém|operador|gerente)\b|\b(humano|atendente|operador)\s+por\s+favor\b|\bsai\s+do\s+bot\b|\bnão\s+(quero|gosto)\s+(de\s+)?(robô|bot|automatic\w*)\b/i;

export const G4_LEGAL_REGEX =
  /\b(procon|advogad\w*|processar|processo\s+judicial|justiça|juiz\w*|reclame\s*aqui|denuncia\w*|denúncia\w*|acionar\s+a\s+justiça|órgão\s+regulador|defensoria|ministério\s+público)\b/i;

/**
 * minúsculas + sem diacríticos — só para o G4_MEDICAL. O vocabulário médico
 * concentra acentos em PT ("torácica", "convulsão") e ES ("médico", "cabeza"),
 * e quem escreve no WhatsApp em pânico não capitaliza acento. Mesma disciplina
 * de `lib/opt-out/deteccao.ts` (`normalizarTexto`) e
 * `lib/agent-engine/guardrails/sinal-de-urgencia.ts` (`normalize`) — mas
 * isolada AQUI, sem tocar G1/G4_LEGAL/UNCERTAINTY, que sempre operaram sobre
 * texto cru e cuja calibração não é deste PR.
 */
export function normalizeForG4Medical(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "");
}

/**
 * G4_MEDICAL — urgência médica relatada pelo CONTATO (freio clínico 1, spec
 * "dois guardrails clínicos determinísticos"). Roda sobre texto JÁ
 * NORMALIZADO (`normalizeForG4Medical` — ver `checkG4Medical`, a única forma
 * suportada de uso); os literais abaixo são todos sem acento de propósito.
 *
 * ⚠️ CONTROLE DE FALSO POSITIVO É O QUE MAIS IMPORTA. Dor crônica é o cliente
 * típico de uma clínica de fisioterapia/pilates — "tem como parar a dor?",
 * "dor nas costas há meses", "dor no ombro depois do treino", "dor de cabeça
 * leve" e "quero morrer de rir" NÃO podem casar aqui (ver o corpus de
 * controle em `tests/unit/handoff-g4-medical.test.ts`). Por isso:
 *   - "dor no peito" exige a palavra "peito" (ou "torax"/"toracica") logo
 *     depois de "dor" — nunca "dor" solta;
 *   - "dor de cabeça" só dispara com um qualificador de gravidade perto
 *     (súbita, muito forte, insuportável, pior da minha vida, do nada) —
 *     "dor de cabeça leve" fica de fora por desenho;
 *   - "quero morrer" tem um lookahead negativo para "de rir/inveja/
 *     vergonha/calor/fome/sono/tedio/felicidade" — a hipérbole cotidiana não
 *     é ideação suicida.
 *
 * Vocabulário coberto (PT-BR obrigatório + ES, mesma paridade do opt-out):
 * dor no peito/torácica, falta de ar/não consigo respirar, desmaio,
 * sangramento que não para, AVC/derrame/rosto-boca torta/fala enrolada,
 * convulsão, fratura exposta, overdose, ideação suicida, queda com trauma de
 * cabeça, dor de cabeça súbita e muito forte, febre alta em bebê — e os
 * equivalentes em espanhol de cada um.
 */
export const G4_MEDICAL_REGEX = new RegExp(
  [
    // ── dor no peito / dor torácica ──────────────────────────────────────
    "dor\\s+(?:no|na)\\s+peito",
    "dor\\s+toraxica|dor\\s+toracica",
    "\\binfarto\\b",
    "dolor\\s+en\\s+el\\s+pecho|dolor\\s+toracico",
    "ataque\\s+cardiaco",
    // ── falta de ar / não consigo respirar ───────────────────────────────
    "falta\\s+de\\s+ar\\b",
    "nao\\s+(?:consigo|consegue|esta)\\s+respirar\\w*",
    "dificuldade\\s+(?:para|de)\\s+respirar",
    "falta\\s+de\\s+aire\\b",
    "no\\s+puedo\\s+respirar|no\\s+puede\\s+respirar",
    // ── desmaio (lookahead negativo: "desmaiar de rir" é hipérbole, não sinal).
    //    `\\b` ANTES do lookahead é obrigatório: sem ele, `\\w*` backtracka até
    //    achar uma posição no MEIO da palavra ("desmai" de "desmaiar") onde o
    //    texto proibido não casa mais, e o veto "passa" por uma palavra
    //    incompleta — medido escrevendo este arquivo.
    "desmai\\w*\\b(?!\\s+de\\s+(?:tanto\\s+)?(?:rir|risada))",
    "desmay\\w*\\b(?!\\s+de\\s+(?:tanta\\s+)?risa)",
    // ── sangramento que não para ──────────────────────────────────────────
    "sangrament\\w*\\s+que\\s+nao\\s+para",
    "nao\\s+para\\s+de\\s+sangrar",
    "sangrando\\s+muito",
    "hemorragia",
    "sangrado\\s+que\\s+no\\s+para",
    "no\\s+para\\s+de\\s+sangrar",
    // ── AVC / derrame / rosto-boca torto / fala enrolada ─────────────────
    // Janela de 20 chars entre o substantivo e o adjetivo — "o rosto dela
    // ficou todo torto" não tem "rosto" colado em "torto".
    "\\bavc\\b",
    // "derrame" solto casaria "derrame no joelho" — derrame ARTICULAR, queixa
    // ortopédica corriqueira em fisioterapia, nada de AVC. Lookahead negativo
    // para articulações e para "articular/sinovial".
    "derrame\\s+cerebral|\\bderrame\\b(?!\\s+(?:articular|sinovial|no\\s+(?:joelho|tornozelo|cotovelo|ombro|quadril|punho)|na\\s+(?:articulacao|perna)))",
    "(?:rosto|boca|face)\\b[^.!?\\n]{0,20}\\b(?:torto|torta)\\b",
    "(?:fala|lingua)\\b[^.!?\\n]{0,20}\\b(?:enrolad\\w*|arrastad\\w*)\\b",
    "\\bacv\\b",
    "cara\\b[^.!?\\n]{0,20}\\btorcida\\b",
    "habla\\b[^.!?\\n]{0,20}\\b(?:enredada|arrastrada)\\b",
    // ── convulsão ─────────────────────────────────────────────────────────
    "convuls\\w*",
    // ── fratura exposta ───────────────────────────────────────────────────
    "fratura\\s+exposta|osso\\s+para\\s+fora",
    "fractura\\s+expuesta",
    // ── overdose ──────────────────────────────────────────────────────────
    "overdose",
    "sobredosis",
    // ── ideação suicida (com lookahead negativo para hipérbole cotidiana) ─
    "quero\\s+morrer\\b(?!\\s+de\\s+(?:tanto\\s+)?(?:rir|risada|inveja|vergonha|calor|fome|sono|tedio|felicidade))",
    "(?:quero|vou)\\s+me\\s+matar\\b",
    "ideacao\\s+suicida|pensamentos?\\s+suicidas?|nao\\s+aguento\\s+mais\\s+viver",
    "quiero\\s+morir\\b(?!\\s+de\\s+(?:tanta\\s+)?(?:risa|envidia|verguenza|calor|hambre|sueno|felicidad))",
    "(?:quiero|voy\\s+a)\\s+matarme\\b|me\\s+quiero\\s+matar\\b",
    "ideacion\\s+suicida|pensamientos?\\s+suicidas?|no\\s+aguanto\\s+mas\\s+vivir",
    // ── queda com trauma de cabeça ────────────────────────────────────────
    "queda\\b[^.!?\\n]{0,20}cabeca",
    "bateu\\s+a\\s+cabeca|cabecada|traumatismo?\\s+(?:na\\s+|de\\s+)?cabeca",
    "caida\\b[^.!?\\n]{0,20}cabeza",
    "se\\s+golpeo\\s+la\\s+cabeza|golpe\\s+en\\s+la\\s+cabeza",
    // ── dor de cabeça súbita e muito forte (exige qualificador de gravidade,
    //    ANTES ou DEPOIS — "a pior dor de cabeça da minha vida" tem o
    //    qualificador na frente) ────────────────────────────────────────
    "dor\\s+de\\s+cabeca\\b[^.!?\\n]{0,20}(?:subita|muito\\s+forte|insuportavel|pior\\s+da\\s+minha\\s+vida|do\\s+nada)",
    "pior\\b[^.!?\\n]{0,10}dor\\s+de\\s+cabeca\\b[^.!?\\n]{0,20}(?:da\\s+minha\\s+vida)?",
    "dolor\\s+de\\s+cabeza\\b[^.!?\\n]{0,20}(?:subito|muy\\s+fuerte|insoportable|el\\s+peor\\s+de\\s+mi\\s+vida)",
    "peor\\b[^.!?\\n]{0,10}dolor\\s+de\\s+cabeza\\b[^.!?\\n]{0,20}(?:de\\s+mi\\s+vida)?",
    // ── febre alta em bebê (ordem livre: "febre" e "alta" podem vir com
    //    "bebe" entre os dois — "a febre do bebê está muito alta") ────────
    "bebe\\b[^.!?\\n]{0,30}febre\\b[^.!?\\n]{0,20}alta\\b",
    "febre\\b[^.!?\\n]{0,30}bebe\\b[^.!?\\n]{0,20}alta\\b",
    "recem[ -]nascido\\b[^.!?\\n]{0,30}febre|rn\\s+com\\s+febre\\s+alta",
    "bebe\\b[^.!?\\n]{0,30}fiebre\\b[^.!?\\n]{0,20}alta\\b",
    "fiebre\\b[^.!?\\n]{0,30}bebe\\b[^.!?\\n]{0,20}alta\\b",
  ].join("|"),
  "u",
);

export const UNCERTAINTY_MARKERS: readonly string[] = [
  "não tenho certeza",
  "não sei",
  "não posso confirmar",
  "não tenho essa informação",
  "preciso verificar",
  "talvez",
  "acho que",
];

export function containsUncertaintyMarkers(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const m of UNCERTAINTY_MARKERS) {
    if (lower.includes(m)) return true;
  }
  return false;
}
