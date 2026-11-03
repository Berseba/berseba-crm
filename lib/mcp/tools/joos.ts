/**
 * Berseba: evaluation slots from Jo OS, for the Instituto Jordão (agent "Fer AI").
 *
 * Jo OS is the clinic's own system and the source of truth of evaluations (`avaliacoes`). Its
 * function `crm-agenda-avaliacao` computes the free slots (`lib/integrations/joos/client.ts`);
 * this tool only picks up to 3 of them and relays them. Nothing here keeps or fixes a rule.
 *
 * SUGGEST ONLY (Samuel, 2026-11-02): there is no booking tool. The agent offers the options and,
 * when the person picks one, hands off to the team, which books in Jo OS and confirms.
 *
 * Same gate as avec and Mirae: only the organizations in `JOOS_AGENDA_ORG_IDS` (install level)
 * have this tool. A failure the agent cannot fix answers `{ok: false, handoff: true, todo}`.
 */
import { z } from "zod";

import { JoOsApiError, listEvaluationSlots, type JoOsSlot } from "@/lib/integrations/joos/client";
import { joOsConfigFor } from "@/lib/integrations/joos/config";
import { logger } from "@/lib/logger";

import type { McpContext, McpToolDefinition } from "../types";

/** Samuel's script: two or three options, on different days. */
export const JOOS_MAX_OPCOES = 3;

const HANDOFF_INSTRUCTION =
  "Não tente de novo. Diga à pessoa, sem falar de erro nem de sistema, que a nossa equipe vai " +
  "ver o melhor horário e já responde por aqui. Depois passe para a equipe (crm_request_human_handoff) " +
  "com a unidade, o dia e o período que a pessoa quer, e o que a equipe precisa fazer (o campo todo).";

const TODO_DEFAULT = "Ver na agenda de avaliações do Jo OS um horário e responder a pessoa.";

/** Codes that mean the Jo OS side or this install is misconfigured: the CRM team must know. */
const INTEGRATION_CODES = new Set(["nao_autorizado", "nao_configurado", "invalid_response", "erro"]);

type Refusal = {
  ok: false;
  permitido: false;
  motivo: string;
  handoff: boolean;
  mensagem: string;
  todo?: string;
};

function refusal(motivo: string, handoff: boolean, mensagem: string, todo?: string): Refusal {
  return { ok: false, permitido: false, motivo, handoff, mensagem, ...(handoff ? { todo: todo ?? TODO_DEFAULT } : {}) };
}

function alertIntegration(ctx: McpContext, code: string, status: number): void {
  logger.error("joos: integration failure", { organization_id: ctx.organizationId, code, status });
  void import("@sentry/nextjs")
    .then((Sentry) => {
      Sentry.captureMessage(`[joos] falha na integração: ${code}`, {
        level: "error",
        tags: { subsystem: "joos", code },
        extra: { organization_id: ctx.organizationId, status },
      });
    })
    .catch(() => {
      /* no Sentry configured: the logger line above is what remains */
    });
}

/** Today in Brasília, `YYYY-MM-DD`. */
export function todayInBrasilia(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now);
}

/** `YYYY-MM-DD` that exists on the calendar: "2026-13-45" and "2026-02-30" do not. */
export function isRealDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/**
 * Does the model's `unidade` name this Jo OS unit? "2", "unidade 2" and "Unidade 2" all name
 * "Unidade 2"; "1" does not name "Unidade 12".
 */
export function unitMatches(asked: string, unitName: string): boolean {
  const a = fold(asked).replace(/^unidade /, "");
  const u = fold(unitName);
  return a.length > 0 && (u === a || u === `unidade ${a}`);
}

const PERIODOS = {
  manha: (h: number) => h < 12,
  tarde: (h: number) => h >= 12 && h < 18,
  noite: (h: number) => h >= 18,
} as const;
const PERIODO_BR = { manha: "manhã", tarde: "tarde", noite: "noite" } as const;

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const weekdayOf = (dia: string) => {
  const [y, m, d] = dia.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]!;
};
/** `03/11`: the agent repeats this, never computes it. */
const dataBr = (dia: string) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
/** `15h`, `15h30`. */
const horaBr = (hora: string) => (hora.endsWith(":00") ? `${Number(hora.slice(0, 2))}h` : `${Number(hora.slice(0, 2))}h${hora.slice(3, 5)}`);

/**
 * Up to `max` options. With one day asked, the first ones of that day; otherwise the first slot
 * of each of the first days, so the person sees different days, as Samuel's script asks.
 */
export function pickOptions(slots: readonly JoOsSlot[], oneDay: boolean, max = JOOS_MAX_OPCOES): JoOsSlot[] {
  const sorted = [...slots].sort((a, b) => a.inicio.localeCompare(b.inicio));
  if (oneDay) return sorted.slice(0, max);
  const picked: JoOsSlot[] = [];
  const days = new Set<string>();
  for (const s of sorted) {
    if (days.has(s.dia)) continue;
    days.add(s.dia);
    picked.push(s);
    if (picked.length >= max) break;
  }
  return picked;
}

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "AAAA-MM-DD")
  .refine(isRealDate, "uma data que exista")
  .optional();

const evaluationSlotsShape = {
  unidade: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .describe('A unidade que a pessoa escolheu, ex.: "1", "Unidade 2". Sem unidade, pergunte antes.'),
  data: date.describe("Um dia exato que a pessoa pediu (AAAA-MM-DD). Sem dia, olha os próximos dias."),
  periodo: z.enum(["manha", "tarde", "noite"]).optional().describe("Período que a pessoa pediu."),
};

export const joosEvaluationSlots: McpToolDefinition<typeof evaluationSlotsShape> = {
  name: "joos_evaluation_slots",
  description:
    `Busca até ${JOOS_MAX_OPCOES} horários livres de AVALIAÇÃO na agenda do Instituto (Jo OS), ` +
    "numa unidade. É só consulta: NADA é marcado. Pergunte a unidade antes de chamar. Ofereça " +
    'exatamente as opções que vierem, com o texto delas (ex.: "terça, 03/11, às 15h"). Nunca ' +
    "ofereça horário que não veio daqui e nunca diga que está marcado ou confirmado. Quando a " +
    "pessoa escolher, diga que vai pedir para a equipe confirmar o horário e passe para a equipe " +
    "(crm_request_human_handoff) com unidade, dia e hora escolhidos. Lista vazia ou falha: siga a mensagem.",
  inputSchema: evaluationSlotsShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const config = joOsConfigFor(ctx.organizationId);
    if (!config) {
      return refusal("joos_indisponivel", false, "esta ferramenta não está disponível nesta empresa.");
    }
    if (input.data && !isRealDate(input.data)) {
      return { ok: false, handoff: false, mensagem: "essa data não existe: confira com a pessoa." };
    }
    const hoje = todayInBrasilia();
    if (input.data && input.data < hoje) {
      return { ok: false, handoff: false, mensagem: "essa data já passou: confira com a pessoa." };
    }
    const quando = [input.data ? dataBr(input.data) : null, input.periodo && PERIODO_BR[input.periodo]]
      .filter(Boolean)
      .join(", ");
    const pedido = `avaliação na unidade ${input.unidade}${quando ? ` (${quando})` : ""}`;

    let answer;
    try {
      answer = await listEvaluationSlots(config, input.data ? { de: input.data, ate: input.data } : {});
    } catch (err) {
      const status = err instanceof JoOsApiError ? err.status : 0;
      const code = err instanceof JoOsApiError ? err.code : "unknown";
      if (INTEGRATION_CODES.has(code) || status === 401 || status >= 500) alertIntegration(ctx, code, status);
      else logger.warn("joos: no answer", { organization_id: ctx.organizationId, code, status });
      return refusal("joos_sem_resposta", true, HANDOFF_INSTRUCTION, `Quer ${pedido}; o Jo OS não respondeu.`);
    }
    if (answer.situacao === "desligado") {
      return refusal("joos_desligado", true, HANDOFF_INSTRUCTION, `Quer ${pedido}; consulta do Jo OS desligada.`);
    }

    const units = [...new Map(answer.horarios.map((h) => [h.unidade_id, h.unidade ?? ""])).values()].filter(Boolean);
    const daUnidade = answer.horarios.filter((h) => h.unidade && unitMatches(input.unidade, h.unidade));
    if (daUnidade.length === 0 && !units.some((u) => unitMatches(input.unidade, u))) {
      return {
        ok: false,
        handoff: false,
        mensagem:
          `não conheço a unidade "${input.unidade}". ` +
          (units.length ? `As unidades com horário são: ${units.sort().join(", ")}. Confirme com a pessoa.` : "Confirme com a pessoa."),
      };
    }
    // A slot that already started is not an option: Jo OS answers by day, and today's morning
    // is still in the list in the afternoon.
    const agora = Date.now();
    const filtrados = daUnidade.filter((h) => {
      const comeca = Date.parse(h.inicio);
      if (!Number.isNaN(comeca) && comeca <= agora) return false;
      if (input.data && h.dia !== input.data) return false;
      return input.periodo ? PERIODOS[input.periodo](Number(h.hora.slice(0, 2))) : true;
    });
    if (filtrados.length === 0) {
      return refusal(
        "sem_horario",
        true,
        "não encontrei horário para esse pedido. Não diga que não há horário: diga que a nossa equipe " +
          "vai ver o melhor horário e já responde por aqui, e passe para a equipe com o pedido e o todo.",
        `Quer ${pedido}; sem horário livre no Jo OS.`,
      );
    }

    return {
      ok: true,
      so_sugestao: true,
      opcoes: pickOptions(filtrados, Boolean(input.data)).map((h) => ({
        texto: `${weekdayOf(h.dia)}, ${dataBr(h.dia)}, às ${horaBr(h.hora)}`,
        unidade: h.unidade,
        dia: h.dia,
        hora: h.hora,
        inicio: h.inicio,
        /** For the team's handoff summary only; never promise the person who evaluates. */
        avaliador_livre: h.avaliador_sugerido,
      })),
      proximo_passo:
        "Ofereça as opções. Quando a pessoa escolher, NÃO diga que está marcado: diga que vai pedir " +
        "para a equipe confirmar e passe para a equipe (crm_request_human_handoff) com unidade, dia, hora " +
        "e o avaliador_livre da opção escolhida.",
    };
  },
};
