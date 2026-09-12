/**
 * FREIO CLÍNICO 2 — NUNCA DIAGNÓSTICO, NUNCA PRESCRIÇÃO.
 *
 * Detector determinístico (regex, sem LLM) do que o assistente de uma
 * clínica/consultório NUNCA pode afirmar sozinho: diagnóstico, prescrição de
 * medicamento, ou promessa de resultado clínico. Consumido por
 * `clinicalScopeGate` em `../guardrails/before-send.ts`, armado só quando
 * `organizations.settings->>'nicho' = 'saude'` (ver `camadas-da-org.ts`,
 * `lerNichoDaOrg`/`nichoEhSaude`) — em qualquer outro nicho o gate é no-op.
 *
 * Mesma disciplina de `human-promise.ts`/`vazamento-interno.ts`: léxico puro,
 * testável sem banco, sem custo de modelo.
 *
 * ⚠️ CONTROLE DE FALSO POSITIVO. "a avaliação com o fisioterapeuta vai
 * identificar", "cada caso é avaliado presencialmente", falar de sessão,
 * exercício, serviço ou preço — nada disso é diagnóstico/prescrição, e o
 * corpus de controle em `tests/unit/gate-clinical-scope.test.ts` prova que
 * essas frases passam.
 */

/**
 * Condições clínicas comuns no vocabulário de fisioterapia/pilates — o
 * substantivo que, combinado com a estrutura "você tem/está com"/"isso é",
 * vira uma afirmação de diagnóstico. Lista fechada de propósito: um
 * substantivo qualquer depois de "você tem" ("você tem razão", "você tem que
 * vir na quinta") não é diagnóstico, e listar as condições evita alargar o
 * gate para qualquer "você tem X".
 */
const CONDICOES_CLINICAS =
  "tendinite|tendinopatia|bursite|bursopatia|h[eé]rnia\\s+de\\s+disco|fascite|fasciite|" +
  "artrose|artrite|escoliose|les[aã]o|ruptura|rompimento|distens[aã]o|contratura|entorse|" +
  "luxa[cç][aã]o|fratura|protrus[aã]o|estenose|compress[aã]o\\s+nervosa|ciatalgia|ci[aá]tica|" +
  "s[ií]ndrome\\s+do\\s+t[uú]nel\\s+do\\s+carpo|epicondilite|labirintite|fibromialgia|" +
  "les[aã]o\\s+muscular|inflama[cç][aã]o\\s+cr[oô]nica";

/**
 * Afirmação de diagnóstico: "você tem/está com <condição>", "isso é
 * <condição>", ou as duas frases estruturais que o spec pede de propósito
 * ("seu problema é", "seu diagnóstico é") — largas o bastante para pegar o
 * caso real, mas ainda ancoradas em frase de veredito, não em qualquer "é".
 */
const DIAGNOSIS_PATTERN = new RegExp(
  `voc[eê]\\s+(?:tem|est[aá]\\s+com)\\s+(?:uma?\\s+)?(?:${CONDICOES_CLINICAS})\\b|` +
    `isso\\s+[eé]\\s+(?:uma?\\s+)?(?:${CONDICOES_CLINICAS})\\b|` +
    // ⚠️ SEM `\b` logo após `[eé]`: "é"/"e" acentuado não é "word char" para o
    // `\b` do JS (ASCII-only, mesmo com a flag `u`) — um `\b` aqui nunca acha
    // fronteira depois de "é" seguido de espaço, e o padrão nunca casava
    // "seu problema é a postura...". Mesma armadilha documentada em
    // `before-send.ts` (`semAcento`), resolvida aqui removendo o `\b` em vez
    // de normalizar (a candidata é o texto do MODELO, sempre bem acentuado).
    "seu\\s+problema\\s+[eé](?=\\s|$)|" +
    "seu\\s+diagn[oó]stico\\s+[eé](?=\\s|$)",
  "iu",
);

/** Analgésicos/anti-inflamatórios/relaxantes comuns — nomeados no spec. */
const MEDICATION_NAMES =
  "ibuprofeno|dipirona|paracetamol|diclofenaco|nimesulida|relaxante\\s+muscular|" +
  "naproxeno|cetoprofeno|ciclobenzaprina|meloxicam";

/** Dose numérica com unidade — "600mg", "2 comprimidos", "20 gotas". */
const DOSAGE_PATTERN = "\\d+\\s*(?:mg|ml|mcg|comprimidos?|c[aá]psulas?|gotas?)\\b";

/**
 * Prescrição: nome de medicamento em qualquer lugar da frase, dose numérica,
 * ou "tome"/"use" perto de um remédio/dose. "Tome" e "use" sozinhos NÃO
 * bastam ("tome cuidado", "use a bolsa de gelo" são orientação legítima) — o
 * verbo só conta perto de vocabulário de medicamento.
 */
const PRESCRIPTION_PATTERN = new RegExp(
  `\\btom(?:e|ar|ando)\\b[^.!?\\n]{0,30}\\b(?:${MEDICATION_NAMES}|${DOSAGE_PATTERN}|comprimido|gota|analg[eé]sico|anti-?inflamat[oó]rio|rem[eé]dio)\\b|` +
    `\\buse\\b[^.!?\\n]{0,20}\\b(?:${MEDICATION_NAMES})\\b|` +
    `\\b(?:${MEDICATION_NAMES})\\b|` +
    DOSAGE_PATTERN,
  "iu",
);

/** Promessa de resultado clínico ("vai curar", "garantimos que a dor some"). */
const CURE_PROMISE_PATTERN =
  /\bvai\s+curar\b|\bgarantimos?\s+que\s+a\s+dor\s+(?:some|passa|desaparece)\b|\bgarantia\s+de\s+cura\b|\bcura\s+garantida\b|\bgarantimos?\s+(?:a\s+)?cura\b/iu;

export type EscopoClinicoCategoria = "diagnostico" | "prescricao" | "promessa_de_cura";

export interface AchadoDeEscopoClinico {
  achou: boolean;
  categorias: readonly EscopoClinicoCategoria[];
}

/**
 * O assistente diagnosticou, prescreveu ou prometeu cura no CORPO CANDIDATO?
 * Pura, síncrona, sem banco — roda no `clinicalScopeGate` (before-send).
 */
export function detectarEscopoClinicoIndevido(body: string): AchadoDeEscopoClinico {
  if (!body || body.trim() === "") return { achou: false, categorias: [] };
  const categorias: EscopoClinicoCategoria[] = [];
  if (DIAGNOSIS_PATTERN.test(body)) categorias.push("diagnostico");
  if (PRESCRIPTION_PATTERN.test(body)) categorias.push("prescricao");
  if (CURE_PROMISE_PATTERN.test(body)) categorias.push("promessa_de_cura");
  return { achou: categorias.length > 0, categorias };
}

const RENDER_POR_CATEGORIA: Record<EscopoClinicoCategoria, string> = {
  diagnostico: "afirmou um diagnóstico",
  prescricao: "prescreveu ou indicou dose de medicamento",
  promessa_de_cura: "prometeu um resultado clínico (cura garantida)",
};

/**
 * Erro instrutivo que volta ao modelo — mesmo mecanismo dos demais gates de
 * conteúdo (`internalVocabularyGate`, `agendaStallGate`): diz o que foi
 * vetado E o que fazer em vez disso.
 */
export function renderVetoDeEscopoClinico(categorias: readonly EscopoClinicoCategoria[]): string {
  const oQueFez = categorias.map((c) => RENDER_POR_CATEGORIA[c]).join(" e ");
  return (
    `Você ${oQueFez} nesta mensagem. Diagnóstico, prescrição de medicamento e promessa de ` +
    "cura só o profissional de saúde pode dar, e só depois de avaliar a pessoa " +
    "PRESENCIALMENTE — nunca pelo chat. Reescreva a mensagem sem diagnosticar, sem " +
    "prescrever e sem prometer cura; convide o contato para agendar uma avaliação com o " +
    "profissional, que é quem vai identificar o que está acontecendo."
  );
}
