/**
 * Berseba (#58): when the auto-return hands a conversation back to the AI, the
 * client message that arrived while it was with a person gets answered.
 *
 * `devolverAtendimentoAoAgente` releases the three locks, but no AI turn runs:
 * the agent only answers the NEXT inbound. The conversation also leaves the
 * human queue (status `ai_handling`), so a client who wrote during the handoff
 * waits for nobody. Measured at the Mayara Morales salon on 2026-10-15: the
 * client wrote at 11:57–11:59 ("tem problema se eu atrasar 20min?"), the cron
 * returned the conversation at 12:00, and at 16:00 she was still unanswered.
 * The salon switched the auto-return off because of it.
 *
 * The fix re-emits the same `ai_agent.dispatch_requested` event the ingestion
 * emits, for the latest inbound. The drain applies every usual gate (eligibility,
 * debounce, anti-backlog, "nobody publishes on this session") and dedups by
 * event id, as `handoff-tecnico.ts` already does for the derivation case.
 *
 * Only a message the client sent AFTER the last human signal counts. A message
 * the AI already handed off on is older than `last_handoff_at`: re-dispatching
 * it would make the agent hand off again every return window, a loop. And only
 * up to 24 h old: the first run after switching the feature on must not answer
 * a "obrigada" from last week.
 *
 * Never throws: the return already happened, and a failure here must not turn a
 * good round into an error. It logs at warn level and the conversation simply
 * waits for the next inbound, as before.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ultimoSinalHumanoMs, type ConversaEmHandoff } from "@/lib/escalacao/devolucao-automatica";
import { logger } from "@/lib/logger";

/** Oldest unanswered client message the return still answers. */
export const IDADE_MAXIMA_DO_PENDENTE_MS = 24 * 60 * 60 * 1000;

export interface PendenteDaDevolucao {
  /** When the latest inbound reached us (`created_at`), in ms. */
  inboundEmMs: number | null;
  /** When the latest outbound was written, in ms. */
  outboundEmMs: number | null;
  /** `ultimoSinalHumanoMs` of the conversation, before the return. */
  sinalHumanoMs: number | null;
  agoraMs: number;
}

/** Pure rule: is there a client message nobody answered since the last human signal? */
export function deveReenfileirarNaDevolucao(p: PendenteDaDevolucao): boolean {
  if (p.inboundEmMs === null) return false;
  if (p.outboundEmMs !== null && p.outboundEmMs >= p.inboundEmMs) return false;
  if (p.sinalHumanoMs !== null && p.inboundEmMs <= p.sinalHumanoMs) return false;
  return p.agoraMs - p.inboundEmMs <= IDADE_MAXIMA_DO_PENDENTE_MS;
}

interface UltimaMensagem {
  id: string;
  contact_id: string | null;
  created_at: string;
}

async function ultimaMensagem(
  admin: SupabaseClient,
  conversa: ConversaEmHandoff,
  direcao: "inbound" | "outbound",
): Promise<UltimaMensagem | null> {
  // Same recency as the drain's anti-backlog check (`sent_at`, then
  // `created_at`): if this picked a different "latest inbound", the drain would
  // drop the event as superseded and the client would still wait.
  const { data, error } = await admin
    .from("messages")
    .select("id, contact_id, created_at")
    .eq("organization_id", conversa.organization_id)
    .eq("conversation_id", conversa.id)
    .eq("direction", direcao)
    .order("sent_at", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`messages: ${error.message}`);
  return ((data ?? []) as UltimaMensagem[])[0] ?? null;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * Re-dispatches the pending client message of a conversation the cron just
 * returned. `conversa` is the row read BEFORE the return (its human-signal
 * stamps are cleared by it). Returns whether an event was emitted.
 */
export async function reenfileirarPendenteDaDevolucao(
  admin: SupabaseClient,
  conversa: ConversaEmHandoff,
  requestId: string,
  agora: Date = new Date(),
): Promise<boolean> {
  try {
    if (!conversa.channel_session_id) return false;
    const inbound = await ultimaMensagem(admin, conversa, "inbound");
    if (!inbound) return false;
    const outbound = await ultimaMensagem(admin, conversa, "outbound");
    const pendente = deveReenfileirarNaDevolucao({
      inboundEmMs: ms(inbound.created_at),
      outboundEmMs: ms(outbound?.created_at),
      sinalHumanoMs: ultimoSinalHumanoMs(conversa),
      agoraMs: agora.getTime(),
    });
    if (!pendente || !inbound.contact_id) return false;

    const { error } = await admin.rpc("emit_event", {
      p_event_type: "ai_agent.dispatch_requested",
      p_entity_kind: "message",
      p_entity_id: inbound.id,
      p_payload: {
        organization_id: conversa.organization_id,
        conversation_id: conversa.id,
        contact_id: inbound.contact_id,
        channel_session_id: conversa.channel_session_id,
        inbound_message_id: inbound.id,
      },
      p_metadata: {
        source: "cron:handoff-devolucao",
        request_id: requestId,
        motivo: "inbound_pendente_na_devolucao",
      },
      p_organization_id: conversa.organization_id,
    });
    if (error) throw new Error(`emit_event: ${error.message}`);
    logger.info("[handoff-devolucao] pending inbound re-dispatched", {
      conversation_id: conversa.id,
      organization_id: conversa.organization_id,
      requestId,
    });
    return true;
  } catch (err) {
    logger.warn("[handoff-devolucao] pending inbound not re-dispatched", {
      conversation_id: conversa.id,
      organization_id: conversa.organization_id,
      error: err instanceof Error ? err.message.slice(0, 160) : String(err),
      requestId,
    });
    return false;
  }
}
