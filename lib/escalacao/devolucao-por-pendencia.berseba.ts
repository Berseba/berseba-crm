/**
 * Berseba: who owes the reply decides when a conversation held by a person goes
 * back to the agent.
 *
 * ## The rule (Matheus, 2026-10-22)
 *
 * - **The client is waiting for the team** (her last message has no human reply
 *   yet, or the agent handed her off and nobody answered): the conversation stays
 *   with the person. No deadline sends it back to the agent.
 * - **The team answered last, or closed the conversation**, and the deadline
 *   (`settings.routing.handoff_return_after_minutes`) has passed: the client's
 *   next message goes to the agent, which triages again and hands off if needed.
 * - Inside the deadline, "a conversa fica com quem atendeu"
 *   (`conversation_stays_with_attendant`) gives it back to the person.
 *
 * ## Why upstream's deadline alone was not enough
 *
 * At the Mayara Morales salon, three setups failed in turn:
 * - **Until 14/10:** "fica com quem atendeu" on, no deadline. Every client the
 *   attendant ever served stayed with her forever, and the agent never answered them again.
 * - **14–15/10:** 120 min deadline. The `handoff-devolucao` cron returned conversations
 *   whose client was waiting for the attendant. The agent only answers the next
 *   message, so the waiting one went unanswered (Berseba/berseba-crm#58).
 * - **Since 15/10:** no deadline, "fica com quem atendeu" off. A client who wrote
 *   again after a closed handoff got a conversation with no owner and a muted agent.
 *   Real case: 20/10, 20 h without an answer.
 *
 * Upstream's cron ignores who owes the reply and never looks at closed
 * conversations ("closing is a decision"). So the rule is applied in two places:
 * - `filtrarClienteAguardando`: the cron skips conversations whose client is waiting;
 * - `devolverAoAgenteSePrazoVenceu`: when the client writes, an expired conversation
 *   goes back to the agent before it is dispatched.
 * Both call `devolverAtendimentoAoAgente`, the same function as the "devolver ao
 * automático" button.
 *
 * ## What counts as the team's signal
 *
 * - A message a person sent through the CRM (`sent_via = 'user'`).
 * - Closing the conversation (`service_closed_at`).
 *
 * What does not count:
 * - Messages sent from the phone (`external_device`). At the salon almost all of
 *   them are avec's automatic reminders (228 of 239 from 14/10 to 20/10).
 * - "Assumir" (`assigned_at`), because it is not an answer. The database also
 *   rewrites `assigned_at` when a closed conversation reopens with its owner.
 *
 * When unsure, the conversation stays with the person. That is the safe side,
 * because a person can always answer. With no deadline configured, nothing here runs.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import { logger } from "@/lib/logger";

import {
  estaComHumanoDuravel,
  lerPrazoDeDevolucaoMinutos,
  type ConversaEmHandoff,
} from "./devolucao-automatica";
import { devolverAtendimentoAoAgente } from "./retomada";

/** What the rule reads about one conversation, as epoch milliseconds. */
export interface Pendencia {
  /** Latest message a person sent through the CRM. */
  ultimaRespostaHumanaMs: number | null;
  /** `conversations.service_closed_at`: the last time someone closed it. */
  fechadaEmMs: number | null;
  /** `conversations.last_handoff_at`: the agent handed the client to the team. */
  ultimaPassagemMs: number | null;
  /** Latest client message, not counting the one being ingested right now. */
  ultimaMensagemDoClienteMs: number | null;
}

export type DecisaoDeDevolucao =
  | { devolver: true }
  | { devolver: false; motivo: "cliente_aguardando" | "dentro_do_prazo" };

/** The team's last signal: a CRM reply or a close, whichever came later. */
export function ultimoSinalDaEquipeMs(p: Pendencia): number | null {
  const sinais = [p.ultimaRespostaHumanaMs, p.fechadaEmMs].filter(
    (t): t is number => t !== null,
  );
  return sinais.length === 0 ? null : Math.max(...sinais);
}

/**
 * The client is waiting for the team when nobody from the team has answered or
 * closed yet, or when the handoff or her latest message came after the team's
 * last signal.
 */
export function clienteAguardandoEquipe(p: Pendencia): boolean {
  const sinal = ultimoSinalDaEquipeMs(p);
  if (sinal === null) return true;
  if (p.ultimaPassagemMs !== null && p.ultimaPassagemMs > sinal) return true;
  return p.ultimaMensagemDoClienteMs !== null && p.ultimaMensagemDoClienteMs > sinal;
}

export function decidirDevolucao(
  p: Pendencia,
  prazoMinutos: number,
  agoraMs: number,
): DecisaoDeDevolucao {
  if (clienteAguardandoEquipe(p)) return { devolver: false, motivo: "cliente_aguardando" };
  // Not waiting means there is a signal (see `clienteAguardandoEquipe`).
  const sinal = ultimoSinalDaEquipeMs(p) as number;
  if (agoraMs - sinal < prazoMinutos * 60_000) return { devolver: false, motivo: "dentro_do_prazo" };
  return { devolver: true };
}

function epoch(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

async function ultimaMensagemEm(
  admin: SupabaseClient,
  organizationId: string,
  conversationId: string,
  filtro: { direction: "inbound" } | { direction: "outbound"; sent_via: "user" },
  semMensagemId: string | null,
): Promise<number | null> {
  let consulta = admin
    .from("messages")
    .select("sent_at")
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .eq("direction", filtro.direction)
    .is("revoked_at", null);
  if (filtro.direction === "outbound") consulta = consulta.eq("sent_via", filtro.sent_via);
  if (semMensagemId) consulta = consulta.neq("id", semMensagemId);
  const { data, error } = await consulta
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`messages: ${error.message}`);
  return epoch((data as { sent_at?: string } | null)?.sent_at);
}

/** Reads the four timestamps of the rule for one conversation. Throws on a read error. */
export async function lerPendencia(
  admin: SupabaseClient,
  organizationId: string,
  conversa: { id: string; service_closed_at: string | null; last_handoff_at: string | null },
  semMensagemId: string | null = null,
): Promise<Pendencia> {
  const [ultimaRespostaHumanaMs, ultimaMensagemDoClienteMs] = await Promise.all([
    ultimaMensagemEm(admin, organizationId, conversa.id, { direction: "outbound", sent_via: "user" }, null),
    ultimaMensagemEm(admin, organizationId, conversa.id, { direction: "inbound" }, semMensagemId),
  ]);
  return {
    ultimaRespostaHumanaMs,
    fechadaEmMs: epoch(conversa.service_closed_at),
    ultimaPassagemMs: epoch(conversa.last_handoff_at),
    ultimaMensagemDoClienteMs,
  };
}

/**
 * The cron's extra guard: keeps only the conversations the rule lets go back to
 * the agent. A read error keeps the conversation with the person.
 */
export async function filtrarClienteAguardando<T extends { conversa: ConversaEmHandoff; minutos: number }>(
  admin: SupabaseClient,
  vencidas: readonly T[],
  agoraMs: number,
): Promise<T[]> {
  const out: T[] = [];
  for (const v of vencidas) {
    try {
      const { data, error } = await admin
        .from("conversations")
        .select("id, service_closed_at, last_handoff_at")
        .eq("organization_id", v.conversa.organization_id)
        .eq("id", v.conversa.id)
        .maybeSingle();
      if (error) throw new Error(`conversations: ${error.message}`);
      if (!data) continue;
      const pendencia = await lerPendencia(
        admin,
        v.conversa.organization_id,
        data as { id: string; service_closed_at: string | null; last_handoff_at: string | null },
      );
      if (decidirDevolucao(pendencia, v.minutos, agoraMs).devolver) out.push(v);
    } catch (err) {
      logger.warn("[devolucao-por-pendencia] cron: conversation kept with the person (read failed)", {
        conversation_id: v.conversa.id,
        detail: err instanceof Error ? err.message.slice(0, 160) : "unknown",
      });
    }
  }
  return out;
}

/** Same gate as the cron: only return where an agent or router serves the session. */
async function sessaoTemAgente(
  admin: SupabaseClient,
  organizationId: string,
  sessaoId: string,
): Promise<boolean> {
  const { data: agentes, error } = await admin
    .from("ai_agents")
    .select("ai_agent_versions!ai_agents_published_version_id_fkey(channel_session_id, status)")
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .not("published_version_id", "is", null);
  if (error) throw new Error(`ai_agents: ${error.message}`);
  type Versao = { channel_session_id: string | null; status: string };
  for (const a of (agentes ?? []) as unknown as Array<{ ai_agent_versions: Versao | Versao[] | null }>) {
    const v = Array.isArray(a.ai_agent_versions) ? (a.ai_agent_versions[0] ?? null) : a.ai_agent_versions;
    if (v?.status === "published" && v.channel_session_id === sessaoId) return true;
  }
  const { data: roteadores, error: erroRoteadores } = await admin
    .from("ai_routers")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("channel_session_id", sessaoId)
    .eq("is_active", true)
    .limit(1);
  if (erroRoteadores) throw new Error(`ai_routers: ${erroRoteadores.message}`);
  return (roteadores ?? []).length > 0;
}

const ATOR_DA_ENTRADA: Actor = { type: "webhook_source", id: "ingest:devolucao-por-pendencia" };

export interface EntradaParaDevolucao {
  organizationId: string;
  contactId: string;
  conversationId: string;
  /** The message being ingested: it is the reason we look, not a pending one. */
  messageId: string | null;
  requestId?: string;
}

/**
 * Runs when a client message arrives, before the agent is dispatched. If the
 * conversation is with a person, the client was not waiting and the deadline
 * passed since the team's last signal, it goes back to the agent so the agent
 * answers this message. Never throws: the message is already stored, and on
 * any doubt the conversation stays with the person.
 */
export async function devolverAoAgenteSePrazoVenceu(
  admin: SupabaseClient,
  entrada: EntradaParaDevolucao,
  agoraMs: number = Date.now(),
): Promise<void> {
  try {
    const { data: org, error: orgErr } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", entrada.organizationId)
      .maybeSingle();
    if (orgErr) throw new Error(`organizations: ${orgErr.message}`);
    const prazo = lerPrazoDeDevolucaoMinutos((org as { settings?: unknown } | null)?.settings);
    if (prazo === null) return;

    const { data: convData, error: convErr } = await admin
      .from("conversations")
      .select(
        "id, organization_id, channel_session_id, status, assignee_kind, assigned_to_user_id, assigned_at, bot_silenced_until, last_handoff_at, last_outbound_at, status_changed_at, service_closed_at, is_group",
      )
      .eq("organization_id", entrada.organizationId)
      .eq("id", entrada.conversationId)
      .maybeSingle();
    if (convErr) throw new Error(`conversations: ${convErr.message}`);
    const conversa = convData as (ConversaEmHandoff & { service_closed_at: string | null; is_group: boolean | null }) | null;
    if (!conversa || conversa.is_group) return;

    const { data: contato, error: contatoErr } = await admin
      .from("contacts")
      .select("force_human, is_blocked")
      .eq("organization_id", entrada.organizationId)
      .eq("id", entrada.contactId)
      .maybeSingle();
    if (contatoErr) throw new Error(`contacts: ${contatoErr.message}`);
    const c = contato as { force_human?: boolean | null; is_blocked?: boolean | null } | null;
    if (c?.is_blocked) return;
    if (!estaComHumanoDuravel(conversa) && c?.force_human !== true) return;
    if (!conversa.channel_session_id) return;
    if (!(await sessaoTemAgente(admin, entrada.organizationId, conversa.channel_session_id))) return;

    const pendencia = await lerPendencia(admin, entrada.organizationId, conversa, entrada.messageId);
    const decisao = decidirDevolucao(pendencia, prazo, agoraMs);
    if (!decisao.devolver) {
      logger.info("[devolucao-por-pendencia] stays with the person", {
        conversation_id: entrada.conversationId,
        motivo: decisao.motivo,
      });
      return;
    }

    const r = await devolverAtendimentoAoAgente(
      {
        supabase: admin,
        organizationId: entrada.organizationId,
        actor: ATOR_DA_ENTRADA,
        requestId: entrada.requestId ?? "ingest",
      },
      { conversationId: entrada.conversationId, origem: { automatica: { minutos: prazo } } },
    );
    if (r.ok) {
      logger.info("[devolucao-por-pendencia] returned to the agent on the client's message", {
        conversation_id: entrada.conversationId,
        minutos: prazo,
      });
    } else {
      logger.warn("[devolucao-por-pendencia] return failed, conversation stays with the person", {
        conversation_id: entrada.conversationId,
        erro: r.erro,
        detail: r.detalhe?.slice(0, 160),
      });
    }
  } catch (err) {
    logger.warn("[devolucao-por-pendencia] check failed, conversation stays with the person", {
      conversation_id: entrada.conversationId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "unknown",
    });
  }
}
