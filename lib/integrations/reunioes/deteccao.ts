/**
 * Berseba (#171, slice 3): the pure half of meeting detection — the install switch, the cheap
 * filter that decides which messages are worth a model call, and the reading of the model's
 * answer into a proposal. No network, no database, no clock of its own.
 */
import { z } from "zod";

import { env } from "@/lib/env";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Organizations with meeting detection (it spends the organization's AI budget). Fails closed. */
export function orgsComDeteccao(bruto: string | undefined = env.MEETING_DETECTION_ORG_IDS): ReadonlySet<string> {
  return new Set(
    (bruto ?? "")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter((v) => UUID.test(v)),
  );
}

export function deteccaoLigada(organizationId: string): boolean {
  return orgsComDeteccao().has(organizationId.toLowerCase());
}

/**
 * Words that make a message worth reading for a meeting. Only these go to the model; everything
 * else is never sent anywhere. Generous on purpose: the model decides, this only saves calls.
 */
const SINAIS =
  /\b(reuni[aã]o|reunir|call|liga[cç][aã]o|ligar|conversar|conversa|papo|marcar|marcamos|agendar|agenda|hor[aá]rio|dispon[ií]vel|disponibilidade|encontro|visita|caf[eé]|amanh[aã]|hoje|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|semana que vem|pr[oó]xima semana|meet|zoom|teams|confirmad[oa]|combinado|fechado)\b|\b\d{1,2}\s?h(\d{2})?\b|\b\d{1,2}:\d{2}\b/i;

export function falaDeReuniao(texto: string | null | undefined): boolean {
  return Boolean(texto && SINAIS.test(texto));
}

/** The tool the model fills. */
export const respostaDoModelo = z.object({
  intencao: z.enum(["pede", "confirma", "nenhuma"]),
  inicio: z.string().nullable().optional(),
  duracao_minutos: z.number().int().nullable().optional(),
  assunto: z.string().nullable().optional(),
});

export interface Proposta {
  intent: "pede" | "confirma" | "nenhuma";
  starts_at: string | null;
  duration_minutes: number | null;
  title: string | null;
}

const ATE_DIAS = 120;

/**
 * The model's answer as a proposal. A start that is not a real instant, is in the past, or is
 * more than four months ahead is dropped (the partner still sees the proposal and picks the
 * time); a duration outside 5–480 minutes too. Unreadable → `null` (nothing stored, retried).
 */
export function lerResposta(bruto: unknown, agora: Date): Proposta | null {
  const r = respostaDoModelo.safeParse(bruto);
  if (!r.success) return null;
  if (r.data.intencao === "nenhuma") return { intent: "nenhuma", starts_at: null, duration_minutes: null, title: null };
  const inicio = r.data.inicio ? new Date(r.data.inicio) : null;
  const valido =
    inicio !== null &&
    !Number.isNaN(inicio.getTime()) &&
    inicio.getTime() > agora.getTime() &&
    inicio.getTime() < agora.getTime() + ATE_DIAS * 24 * 60 * 60 * 1000;
  const duracao = r.data.duracao_minutos ?? null;
  const assunto = r.data.assunto?.trim().slice(0, 200) || null;
  return {
    intent: r.data.intencao,
    starts_at: valido ? inicio!.toISOString() : null,
    duration_minutes: duracao !== null && duracao >= 5 && duracao <= 480 ? duracao : null,
    title: assunto,
  };
}

/** What the screen keeps of the message: its first 500 characters, collapsed. */
export function trechoDa(texto: string): string {
  return texto.replace(/\s+/g, " ").trim().slice(0, 500);
}

export const SISTEMA_DA_DETECCAO = [
  "Você lê UMA mensagem que um cliente mandou para uma consultoria (por e-mail ou WhatsApp) e responde só pela ferramenta informar_reuniao.",
  "intencao = 'pede' quando o cliente pede ou propõe uma reunião, call, visita ou conversa marcada (com ou sem horário).",
  "intencao = 'confirma' quando o cliente confirma um dia e horário já combinados.",
  "intencao = 'nenhuma' em qualquer outro caso, inclusive quando só cita uma reunião que já aconteceu, cancela, ou fala de prazo de entrega.",
  "inicio: o dia e horário propostos ou confirmados, em ISO 8601 com o fuso, calculado a partir de 'Agora' abaixo; null se não houver horário claro.",
  "duracao_minutos: só se o cliente disser; senão null. assunto: até 8 palavras sobre o tema da reunião, ou null.",
  "Nunca invente horário. Em dúvida entre 'pede' e 'nenhuma', escolha 'nenhuma'.",
].join("\n");
