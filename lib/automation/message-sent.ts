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
 * `event.body_preview` and `event.sent_via` on both paths, and a message that
 * no longer exists (the echo of our own send, which the send deletes right
 * after stamping the id) triggers nothing.
 *
 * ─── Why only people trigger it ────────────────────────────────────────────
 *
 * The trigger exists so the funnel moves with what reception WRITES. The AI and
 * the automations also emit `message.sent`; letting them through by default
 * would make a "contains agendado" rule move the card on an agent's sentence
 * that only offered a time slot. A rule that wants another origin says so
 * explicitly: a condition on `event.sent_via` (e.g. `event.sent_via eq ai`).
 * The engine's anti-loop guard (`request_id` prefixed `rule:`) still applies on
 * top of this: a message a rule sent never triggers a rule again, not even
 * with the explicit opt-in.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuleCondition } from "@/lib/automation/conditions";
import type { EventRow } from "@/lib/event-log/dispatcher";

export const MESSAGE_SENT_TRIGGER = "message.sent";

/**
 * The origins that are PEOPLE, in `messages.sent_via` vocabulary: the attendant
 * in the CRM (`user`, plus the legacy `crm`) and the attendant on the phone
 * (`external_device`). `ai`, `automation` and `system` (server token) are out
 * by default.
 */
export const TEAM_ORIGINS: ReadonlySet<string> = new Set(["user", "crm", "external_device"]);

/** The condition field that lets the other origins in. */
export const ORIGIN_FIELD = "event.sent_via";

/** Same cap as the `fn_emit_message_event` trigger (`left(body, 280)`). */
const PREVIEW_MAX = 280;

interface MessageRow {
  id: string;
  conversation_id: string | null;
  contact_id: string | null;
  body: string | null;
  sent_via: string | null;
  status: string | null;
  direction: string | null;
}

export type SentMessage =
  | { ok: true; event: Record<string, unknown>; contactId: string | null }
  | { ok: false; reason: "message_not_found" | "message_not_delivered" };

/**
 * The event's message, read from its row (filtered by the event's
 * organization: the client is service role) and returned as the `event` the
 * rule sees.
 */
export async function readSentMessage(admin: SupabaseClient, row: EventRow): Promise<SentMessage> {
  const payload = row.payload ?? {};
  const id = row.entity_id ?? (typeof payload.message_id === "string" ? payload.message_id : null);
  if (!id) return { ok: false, reason: "message_not_found" };
  const { data } = await admin
    .from("messages")
    .select("id, conversation_id, contact_id, body, sent_via, status, direction")
    .eq("id", id)
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  const msg = data as MessageRow | null;
  if (!msg || msg.direction !== "outbound") return { ok: false, reason: "message_not_found" };
  // The CRM send emits `message.sent` even when the channel refused it: the
  // sentence never reached the client, so it closes no funnel.
  if (msg.status === "failed") return { ok: false, reason: "message_not_delivered" };
  const preview =
    typeof payload.body_preview === "string"
      ? payload.body_preview
      : typeof msg.body === "string"
        ? msg.body.slice(0, PREVIEW_MAX)
        : null;
  return {
    ok: true,
    contactId: msg.contact_id ?? (typeof payload.contact_id === "string" ? payload.contact_id : null),
    event: {
      ...payload,
      message_id: msg.id,
      conversation_id: msg.conversation_id ?? payload.conversation_id ?? null,
      contact_id: msg.contact_id ?? payload.contact_id ?? null,
      body_preview: preview,
      sent_via: msg.sent_via,
    },
  };
}

/**
 * Does the rule accept this message's origin? People always; anything else
 * only when the rule has a condition on `event.sent_via`, and then the
 * condition decides.
 */
export function ruleAcceptsOrigin(
  conditions: readonly RuleCondition[] | null | undefined,
  event: Record<string, unknown> | undefined,
): boolean {
  const origin = event?.sent_via;
  if (typeof origin === "string" && TEAM_ORIGINS.has(origin)) return true;
  return (conditions ?? []).some((c) => c.field === ORIGIN_FIELD);
}
