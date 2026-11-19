/**
 * Berseba: `crm_list_lead_events` — what happened to a set of leads since a date
 * (Berseba/berseba#270, the CRM part).
 *
 * The platform's Prospector worker reads it to know which enterprise leads were already
 * touched and to fill the outcome of each decision (touched, replied, meeting). Counts
 * are not enough there: it needs the instant and the lead. So it returns one row per
 * event, and nothing else: no text, no names, no phone numbers.
 *
 * The definitions are the ones of `analytics.v1_contagem_dia`
 * (supabase/migrations/20261112180917_9005_analytics_contagem.sql):
 *
 *  - `touch`   a `touch` activity on the lead (channel = `payload.channel`), or an
 *              outbound WhatsApp message to the lead's contact (not failed, not a group,
 *              any sender), channel `whatsapp`;
 *  - `reply`   an inbound message from the lead's contact in a non-group conversation,
 *              channel = the conversation's channel;
 *  - `meeting` an `appointment_scheduled` activity on the lead, channel null.
 *
 * Messages are collapsed to the first one per (lead, São Paulo day, kind): a conversation
 * of forty messages is one touch and one reply that day, which is also how the view
 * counts it. Activities are not collapsed (each one was recorded on purpose).
 *
 * Scope: `ctx.supabase` is the service-role client, so RLS does not apply and every query
 * filters `organization_id` explicitly. A lead id of another organization, unknown, or of
 * a personal contact (spec 21: reads exclude them) is silently absent, the same as a lead
 * with no events: the answer never tells "exists elsewhere" from "has nothing". Inside an
 * agent turn only the leads of the turn's contact are read, like the other lead reads.
 */
import { z } from "zod";

import type { McpContext, McpToolDefinition } from "../types";

export type LeadEventKind = "touch" | "reply" | "meeting";

export interface LeadEvent {
  lead_id: string;
  /** ISO 8601, UTC. */
  at: string;
  kind: LeadEventKind;
  channel: string | null;
}

const TIME_ZONE = "America/Sao_Paulo";

/** Rows per page when reading messages (PostgREST `max_rows` is 1000 in supabase/config.toml). */
const MESSAGE_PAGE_SIZE = 1000;
/** At most this many pages of messages per call (20,000 rows): a ceiling, not a target. */
const MAX_MESSAGE_PAGES = 20;

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** `YYYY-MM-DD` of an instant in São Paulo. */
export function saoPauloDay(iso: string): string {
  return dayFormatter.format(new Date(iso));
}

function toIso(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function fail(what: string, message: string): never {
  throw new Error(`crm_list_lead_events: ${what} failed: ${message}`);
}

interface LeadRow {
  id: string;
  contact_id: string | null;
}

interface ActivityRow {
  lead_id: string;
  type: string;
  channel: unknown;
  performed_at: string;
}

interface ConversationRow {
  id: string;
  contact_id: string;
  channel: string | null;
}

interface MessageRow {
  conversation_id: string;
  direction: string;
  status: string | null;
  sent_at: string | null;
  created_at: string | null;
}

/**
 * The events of `leadIds` since `since`, sorted by `at`. Exported for the tests; the tool
 * below is the only caller.
 */
export async function listLeadEvents(
  ctx: McpContext,
  leadIds: readonly string[],
  since: string,
): Promise<LeadEvent[]> {
  const sinceIso = new Date(since).toISOString();
  const org = ctx.organizationId;
  const ids = [...new Set(leadIds)];
  if (ids.length === 0) return [];

  // 1. The leads, of this organization only (and of the turn's contact, inside a turn).
  let leadQuery = ctx.supabase
    .from("crm_leads")
    .select("id, contact_id")
    .eq("organization_id", org)
    .in("id", ids);
  if (ctx.contatoDoTurno) leadQuery = leadQuery.eq("contact_id", ctx.contatoDoTurno);
  const { data: leadData, error: leadError } = await leadQuery;
  if (leadError) fail("leads", leadError.message);
  let leads = (leadData ?? []) as LeadRow[];
  if (leads.length === 0) return [];

  // 2. Personal contacts are out of every read (spec 21), with their leads.
  const contactIds = [
    ...new Set(leads.map((l) => l.contact_id).filter((c): c is string => Boolean(c))),
  ];
  if (contactIds.length > 0) {
    const { data: personal, error: personalError } = await ctx.supabase
      .from("contacts")
      .select("id")
      .eq("organization_id", org)
      .eq("is_personal", true)
      .in("id", contactIds);
    if (personalError) fail("contacts", personalError.message);
    const personalIds = new Set(((personal ?? []) as Array<{ id: string }>).map((c) => c.id));
    if (personalIds.size > 0) {
      leads = leads.filter((l) => !l.contact_id || !personalIds.has(l.contact_id));
    }
  }
  if (leads.length === 0) return [];

  const events: LeadEvent[] = [];
  const visibleLeadIds = leads.map((l) => l.id);

  // 3. Touch and meeting activities.
  const { data: activityData, error: activityError } = await ctx.supabase
    .from("crm_lead_activities")
    .select("lead_id, type, channel:payload->>channel, performed_at")
    .eq("organization_id", org)
    .in("lead_id", visibleLeadIds)
    .in("type", ["touch", "appointment_scheduled"])
    .gte("performed_at", sinceIso)
    .order("performed_at", { ascending: true });
  if (activityError) fail("activities", activityError.message);
  for (const a of (activityData ?? []) as ActivityRow[]) {
    const at = toIso(a.performed_at);
    if (!at || at < sinceIso) continue;
    if (a.type === "touch") {
      events.push({
        lead_id: a.lead_id,
        at,
        kind: "touch",
        channel: typeof a.channel === "string" && a.channel.length > 0 ? a.channel : null,
      });
    } else if (a.type === "appointment_scheduled") {
      events.push({ lead_id: a.lead_id, at, kind: "meeting", channel: null });
    }
  }

  // 4. Messages with the leads' contacts, in non-group conversations.
  const leadsByContact = new Map<string, string[]>();
  for (const l of leads) {
    if (!l.contact_id) continue;
    const list = leadsByContact.get(l.contact_id) ?? [];
    list.push(l.id);
    leadsByContact.set(l.contact_id, list);
  }
  const visibleContactIds = [...leadsByContact.keys()];
  if (visibleContactIds.length > 0) {
    const { data: convData, error: convError } = await ctx.supabase
      .from("conversations")
      .select("id, contact_id, channel")
      .eq("organization_id", org)
      .in("contact_id", visibleContactIds)
      .eq("is_group", false);
    if (convError) fail("conversations", convError.message);
    const conversations = new Map<string, ConversationRow>();
    for (const c of (convData ?? []) as ConversationRow[]) conversations.set(c.id, c);

    if (conversations.size > 0) {
      // First message per (lead, São Paulo day, kind).
      const firstOfDay = new Map<string, LeadEvent>();
      const keep = (event: LeadEvent) => {
        const key = `${event.lead_id}|${saoPauloDay(event.at)}|${event.kind}`;
        const current = firstOfDay.get(key);
        if (!current || event.at < current.at) firstOfDay.set(key, event);
      };

      for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
        const from = page * MESSAGE_PAGE_SIZE;
        const { data: msgData, error: msgError } = await ctx.supabase
          .from("messages")
          .select("conversation_id, direction, status, sent_at, created_at")
          .eq("organization_id", org)
          .in("conversation_id", [...conversations.keys()])
          .gte("sent_at", sinceIso)
          .order("sent_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, from + MESSAGE_PAGE_SIZE - 1);
        if (msgError) fail("messages", msgError.message);
        const rows = (msgData ?? []) as MessageRow[];

        for (const m of rows) {
          const conversation = conversations.get(m.conversation_id);
          if (!conversation) continue;
          const at = toIso(m.sent_at) ?? toIso(m.created_at);
          if (!at || at < sinceIso) continue;
          let kind: LeadEventKind;
          let channel: string | null;
          if (m.direction === "outbound") {
            // As in v1_contagem_dia: only WhatsApp, and a failed send is no touch.
            if (m.status === "failed" || conversation.channel !== "whatsapp") continue;
            kind = "touch";
            channel = "whatsapp";
          } else if (m.direction === "inbound") {
            kind = "reply";
            channel = conversation.channel ?? null;
          } else {
            continue;
          }
          for (const leadId of leadsByContact.get(conversation.contact_id) ?? []) {
            keep({ lead_id: leadId, at, kind, channel });
          }
        }

        if (rows.length < MESSAGE_PAGE_SIZE) break;
      }
      events.push(...firstOfDay.values());
    }
  }

  const kindOrder: Record<LeadEventKind, number> = { touch: 0, reply: 1, meeting: 2 };
  events.sort(
    (a, b) =>
      a.at.localeCompare(b.at) ||
      a.lead_id.localeCompare(b.lead_id) ||
      kindOrder[a.kind] - kindOrder[b.kind],
  );
  return events;
}

const inputShape = {
  lead_ids: z.array(z.string().uuid()).min(1).max(100),
  since: z.string().datetime({ offset: true }),
};

export const crmListLeadEvents: McpToolDefinition<typeof inputShape> = {
  name: "crm_list_lead_events",
  description:
    "Eventos dos negócios desde `since`, em ordem de `at`: kind 'touch' (toque registrado ou WhatsApp enviado), " +
    "'reply' (mensagem do contato) ou 'meeting' (reunião agendada), com o canal. Mensagens: a primeira do dia por negócio. " +
    "Sem texto nem dados do contato.",
  inputSchema: inputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => ({
    events: await listLeadEvents(ctx, input.lead_ids, input.since),
  }),
};
