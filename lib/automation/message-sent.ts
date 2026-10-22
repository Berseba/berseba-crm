/**
 * Berseba (#57, BERSEBA.md): the `message.sent` trigger — a message the TEAM sent.
 *
 * ─── Why the engine reads the ROW and not the payload ──────────────────────
 *
 * `message.sent` has two emitters, and neither carries everything:
 *
 *   - the CRM send (`app/api/v1/messages/_handler.ts`) emits
 *     `{ status, conversation_id }`: no text, no contact, no origin;
 *   - the phone reply enters through the channel ingest as an
 *     `external_device` row born `sent`, and the `fn_emit_message_event`
 *     trigger emits it with `body_preview` and `contact_id`, but no `sent_via`.
 *
 * Only the `messages` row knows all three. Read from it, a rule sees
 * `event.body_preview` and `event.sent_via` on both paths.
 *
 * ─── What does NOT trigger it ──────────────────────────────────────────────
 *
 *   - The ECHO of our own send. Every CRM, AI or automation send comes back
 *     from the channel as an `external_device` row born `sent`, and the send
 *     deletes it only after the channel answers. Read as a phone reply, it
 *     would let AI messages fire the rule, fire CRM sends twice, and bring a
 *     rule's own message back without the `rule:` request_id (past the
 *     anti-loop). The QR-code channel ingest flags it at birth (`metadata.own_send_echo`);
 *     for the other channels, an outbound row of ours in the same conversation
 *     with the same text, created just before, marks it as an echo too.
 *   - A message that did not go out: only `sent`, `delivered` and `read` pass
 *     (`queued` without a configured channel and `failed` do not).
 *   - A message ANOTHER SYSTEM sent from the business's number (a scheduling
 *     system's reminder), when the organization lists its snippet in
 *     `settings.automated_outbound_patterns` (#75).
 *   - A WhatsApp GROUP conversation: a group contact never enters a funnel
 *     (CLAUDE.md), and `create_or_move_lead` would create a lead for it.
 *   - A message that no longer exists (an echo already deleted by the send).
 *   - A backlog event: older than `MAX_EVENT_AGE_MS` on its first pass (see
 *     `isStaleBacklog`).
 *
 * ─── Why only people trigger it ────────────────────────────────────────────
 *
 * The trigger exists so the funnel moves with what reception WRITES. The AI and
 * the automations also emit `message.sent`; letting them through by default
 * would make a "contains agendado" rule move the card on an agent's sentence
 * that only offered a time slot. A rule that wants another origin NAMES it: a
 * condition `event.sent_via eq <origin>` (e.g. `eq ai`). Only `eq` opens an
 * origin — `neq user` does not open `ai`. The engine's anti-loop guard
 * (`request_id` prefixed `rule:`) still applies on top of this: a message a
 * rule sent never triggers a rule again, not even with the explicit opt-in.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuleCondition } from "@/lib/automation/conditions";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { casaComPadraoAutomatico, lerPadroesAutomaticos } from "@/lib/escalacao/mensagem-automatica.berseba";
import { semAssinatura } from "@/lib/messaging/assinatura";

export const MESSAGE_SENT_TRIGGER = "message.sent";

/**
 * The origins that are PEOPLE, in `messages.sent_via` vocabulary: the attendant
 * in the CRM (`user`, plus the legacy `crm`) and the attendant on the phone
 * (`external_device`). `ai`, `automation` and `system` (server token) are out
 * by default.
 */
export const TEAM_ORIGINS: ReadonlySet<string> = new Set(["user", "crm", "external_device"]);

/** The condition field that lets the other origins in (with `eq`). */
export const ORIGIN_FIELD = "event.sent_via";

/** The statuses of a message that actually went out. */
export const DELIVERED_STATUSES: ReadonlySet<string> = new Set(["sent", "delivered", "read"]);

/** Rows that were born HERE (the send handler), as opposed to the channel's `external_device`. */
const OUR_SEND_ORIGINS = ["ai", "user", "automation", "system", "crm"];

/**
 * How far back an echo's original can be. Generous on purpose: the original is
 * written before the channel is called, and a slow channel answer is the very
 * window in which the echo arrives.
 */
const ECHO_WINDOW_MS = 2 * 60 * 1000;

/**
 * A `message.sent` older than this on its FIRST pass is backlog, not a fact to
 * react to. The drain picks a new event in seconds; the case this exists for
 * is the deploy gap: once migration 9002 is applied the rows are born
 * `pending`, and if the new image is not running yet they pile up and would
 * fire rules on old messages when it starts.
 */
export const MAX_EVENT_AGE_MS = 10 * 60 * 1000;

/** Same cap as the `fn_emit_message_event` trigger (`left(body, 280)`). */
const PREVIEW_MAX = 280;

interface MessageRow {
  id: string;
  conversation_id: string | null;
  contact_id: string | null;
  body: string | null;
  type: string | null;
  sent_via: string | null;
  status: string | null;
  direction: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
}

export type SentMessageSkip =
  | "message_not_found"
  | "message_not_delivered"
  | "own_send_echo"
  | "another_system"
  | "group_conversation";

export type SentMessage =
  | { ok: true; event: Record<string, unknown>; contactId: string | null }
  | { ok: false; reason: SentMessageSkip };

/**
 * The event's message, read from its row (every read filtered by the event's
 * organization: the client is service role) and returned as the `event` the
 * rule sees — or the reason it must not trigger anything.
 */
export async function readSentMessage(admin: SupabaseClient, row: EventRow): Promise<SentMessage> {
  const payload = row.payload ?? {};
  const org = row.organization_id;
  const id = row.entity_id ?? (typeof payload.message_id === "string" ? payload.message_id : null);
  if (!id) return { ok: false, reason: "message_not_found" };
  const { data } = await admin
    .from("messages")
    .select("id, conversation_id, contact_id, body, type, sent_via, status, direction, metadata, created_at")
    .eq("id", id)
    .eq("organization_id", org)
    .maybeSingle();
  const msg = data as MessageRow | null;
  if (!msg || msg.direction !== "outbound") return { ok: false, reason: "message_not_found" };
  if (!msg.status || !DELIVERED_STATUSES.has(msg.status)) return { ok: false, reason: "message_not_delivered" };
  if (msg.sent_via === "external_device" && (await isOwnSendEcho(admin, org, msg))) {
    return { ok: false, reason: "own_send_echo" };
  }
  if (msg.sent_via === "external_device" && (await isAnotherSystemMessage(admin, org, msg.body))) {
    return { ok: false, reason: "another_system" };
  }
  const contactId = msg.contact_id ?? (typeof payload.contact_id === "string" ? payload.contact_id : null);
  if (await isGroupConversation(admin, org, msg.conversation_id, contactId)) {
    return { ok: false, reason: "group_conversation" };
  }
  const preview =
    typeof payload.body_preview === "string"
      ? payload.body_preview
      : typeof msg.body === "string"
        ? msg.body.slice(0, PREVIEW_MAX)
        : null;
  return {
    ok: true,
    contactId,
    event: {
      ...payload,
      message_id: msg.id,
      conversation_id: msg.conversation_id ?? payload.conversation_id ?? null,
      contact_id: contactId,
      body_preview: preview,
      sent_via: msg.sent_via,
    },
  };
}

/**
 * Is this `external_device` row the channel's echo of something WE sent?
 *
 * The QR-code channel ingest decides at birth and flags the row. Without the flag (other
 * channels, rows from before the flag), the same evidence the ingest uses: an
 * outbound row of ours in the same conversation, created in the window just
 * before, with the same text (signature line stripped) — or, for media, of a
 * media type too. A read failure answers "not an echo": the cost of a missed
 * echo is one extra move, the cost of a false echo is a reply that never moves
 * the funnel, silently.
 */
async function isOwnSendEcho(admin: SupabaseClient, org: string, msg: MessageRow): Promise<boolean> {
  if (msg.metadata?.own_send_echo === true) return true;
  if (!msg.conversation_id || !msg.created_at) return false;
  const until = new Date(msg.created_at).getTime();
  if (!Number.isFinite(until)) return false;
  const { data, error } = await admin
    .from("messages")
    .select("id, body, type")
    .eq("organization_id", org)
    .eq("conversation_id", msg.conversation_id)
    .eq("direction", "outbound")
    .in("sent_via", OUR_SEND_ORIGINS)
    .neq("id", msg.id)
    .gte("created_at", new Date(until - ECHO_WINDOW_MS).toISOString())
    .lte("created_at", msg.created_at)
    .limit(20);
  if (error) return false;
  const echoBody = (msg.body ?? "").trim();
  const isText = !msg.type || msg.type === "text" || msg.type === "chat";
  for (const ours of (data ?? []) as Array<{ body: string | null; type: string | null }>) {
    const oursIsText = !ours.type || ours.type === "text" || ours.type === "chat";
    if (!isText) {
      if (!oursIsText) return true;
      continue;
    }
    const written = (ours.body ?? "").trim();
    if (echoBody.length > 0 && (written === echoBody || written === semAssinatura(echoBody).trim())) return true;
  }
  return false;
}

/**
 * A message another system sent from the business's own number (a scheduling
 * system's reminder), per `organizations.settings.automated_outbound_patterns`
 * (#75). It is not the team writing, so it must not move the funnel either. A
 * read failure answers "a person", the same fail-closed as the AI-pause guard.
 */
async function isAnotherSystemMessage(admin: SupabaseClient, org: string, body: string | null): Promise<boolean> {
  if (!body) return false;
  const { data, error } = await admin.from("organizations").select("settings").eq("id", org).maybeSingle();
  if (error) return false;
  return casaComPadraoAutomatico(body, lerPadroesAutomaticos((data as { settings?: unknown } | null)?.settings));
}

/** A WhatsApp group conversation, by the conversation flag or the group placeholder contact. */
async function isGroupConversation(
  admin: SupabaseClient,
  org: string,
  conversationId: string | null,
  contactId: string | null,
): Promise<boolean> {
  if (conversationId) {
    const { data } = await admin
      .from("conversations")
      .select("is_group")
      .eq("id", conversationId)
      .eq("organization_id", org)
      .maybeSingle();
    if ((data as { is_group?: boolean } | null)?.is_group === true) return true;
  }
  if (contactId) {
    const { data } = await admin
      .from("contacts")
      .select("kind")
      .eq("id", contactId)
      .eq("organization_id", org)
      .maybeSingle();
    if ((data as { kind?: string } | null)?.kind === "whatsapp_group") return true;
  }
  return false;
}

/**
 * Backlog, not a fact: a `message.sent` older than `MAX_EVENT_AGE_MS` on its
 * first pass. Not backlog when the engine already saw it — a retry after a
 * handler error (`attempts > 0`) or a postponement that came back at its
 * `retry_at` (an `automation_rule_runs` row for the event). Fails OPEN without
 * `created_at`: without the age it cannot claim the event is old.
 */
export async function isStaleBacklog(admin: SupabaseClient, row: EventRow, now = Date.now()): Promise<boolean> {
  if (!row.created_at) return false;
  const born = new Date(row.created_at).getTime();
  if (!Number.isFinite(born) || now - born <= MAX_EVENT_AGE_MS) return false;
  if ((row.attempts ?? 0) > 0) return false;
  const { data, error } = await admin
    .from("automation_rule_runs")
    .select("id")
    .eq("event_id", row.id)
    .eq("organization_id", row.organization_id)
    .limit(1)
    .maybeSingle();
  // A read failure cannot prove the engine never saw it: fail open.
  if (error) return false;
  return !data;
}

/**
 * Does the rule accept this message's origin? People always. Any other origin
 * only when the rule NAMES it with `event.sent_via eq <origin>` — then the
 * condition still decides with the others. A `neq` never opens an origin.
 */
export function ruleAcceptsOrigin(
  conditions: readonly RuleCondition[] | null | undefined,
  event: Record<string, unknown> | undefined,
): boolean {
  const origin = event?.sent_via;
  if (typeof origin !== "string") return false;
  if (TEAM_ORIGINS.has(origin)) return true;
  return (conditions ?? []).some((c) => c.field === ORIGIN_FIELD && c.op === "eq" && c.value === origin);
}
