/**
 * Berseba: a Mirae reminder becomes a message written by the agent (berseba-crm#127).
 *
 * In Mirae every manual follow-up is a reminder on the agenda. A "WhatsApp message" reminder, and
 * the confirmations Mirae sends about a day before an initial evaluation or a first class, call
 * `POST /api/v1/mirae/reminder-messages` from a queue with retries. The CRM never writes a fixed
 * text: the studio's WhatsApp number is connected by QR, with no template, and the same text to many people
 * trips the spinning guard. The text is written by the published agent from the briefing.
 *
 * How it is delivered is the organization's choice, in the CRM (`organizations.settings
 * .mirae_reminder_delivery`), never Mirae's:
 *
 *  - `draft` (default): an agent draft in the conversation, approved by a person in the inbox;
 *  - `auto`: the confirmations (`evaluation_confirmation`, `first_class_confirmation`) with a valid
 *    `appointment_start_at` are sent
 *    by the agent's normal turn, through the whole send gate (window, pacing, spinning, opt-out,
 *    handoff). A `manual` reminder, or a contact a person is handling (`force_human`, "always
 *    human", internal contact, silenced conversation), still becomes a draft;
 *  - `off`: refused with 422, Mirae shows the failure.
 *
 * A charge notice (`kind: "charge"`, Mirae ADR-052 addendum 2026-11-18) carries the Asaas invoice
 * link, the due date and the amount of an enrollment installment, the one place financial values
 * reach the CRM from Mirae. On `auto` it is sent with no appointment time; a missing or invalid
 * charge field is a 422 (`invalid_charge`), final for Mirae's queue.
 *
 * Either way the endpoint only QUEUES: a one-shot `followup_turn` (`cron_jobs` kind `at`, due
 * now) carrying the briefing under `payload.mirae_reminder`. The worker runs it
 * (`lib/agent-engine/agent/mirae-reminder-turn.berseba.ts`); outside the channel's send window
 * the automatic turn is deferred to the next opening, never dropped.
 *
 * Rules, in order, all inside one transaction holding a lock on (organization, delivery key):
 *  1. the delivery key (`delivery_key`, else `reminder_id`) seen before → the same answer, nothing
 *     created (one message per key, ever);
 *  2. contact by phone (both spellings of the 9th digit); none, anonymized or merged, or no 1:1
 *     conversation → `contact_not_found`;
 *  3. `contacts.is_blocked` → `contact_blocked`;
 *  4. under a second lock on (organization, contact), a live scheduled return for this contact
 *     (`cron_jobs`) or a return turn already queued or running (`job_queue`, e.g. one deferred to
 *     the next send window) → `already_handled`, so the person never gets two messages. Not for a
 *     charge notice: the payment link must reach the person whatever else is on its way; and a
 *     queued charge notice does not swallow a confirmation either;
 *  5. queue the turn → `drafted` or `scheduled`.
 *
 * Logs carry ids and outcomes only, never the phone or the briefing.
 */
import type pg from "pg";
import { z } from "zod";

import { parseServiceBoundary, type ServiceBoundary } from "@/lib/atendimento/fronteira";
import { escolherContatoCanonico } from "@/lib/channels/contato-por-telefone";
import { asaasInvoiceLinkOf } from "@/lib/integrations/mirae/asaas-link";
import { normalizePhoneBR, phoneLookupVariants } from "@/lib/channels/phone-variants";
import {
  CHARGE_NOTICE_KIND,
  CONFIRMATION_KINDS,
  MIRAE_REMINDER_KINDS,
  MIRAE_REMINDER_SOURCE,
  type MiraeReminderKind,
  type MiraeReminderPayload,
} from "@/lib/agent-engine/agent/mirae-reminder-turn.berseba";

export const MIRAE_REMINDER_DELIVERY_MODES = ["off", "draft", "auto"] as const;
export type MiraeReminderDelivery = (typeof MIRAE_REMINDER_DELIVERY_MODES)[number];
/** The issue's behaviour: a draft a person approves. */
export const DEFAULT_REMINDER_DELIVERY: MiraeReminderDelivery = "draft";

const isoDateTime = z.string().datetime({ offset: true });

/**
 * The body Mirae sends (`apps/web/src/lib/reminders/delivery/crm-connector.ts`). Unknown fields
 * pass: Mirae adds fields before the CRM reads them, and a 400 is final for its queue. An
 * `organization_id` in the body is never read: the organization is the token's.
 */
export const miraeReminderMessageSchema = z
  .object({
    reminder_id: z.string().trim().min(1).max(200),
    /** Mirae's idempotency key (`reminder_id:due_at`): a rescheduled reminder is a new message. */
    delivery_key: z.string().trim().min(1).max(300).optional(),
    phone: z.string().trim().min(8).max(40),
    /** First name only (Mirae ADR-079 §2). */
    studentName: z.string().trim().max(120).optional(),
    /** The briefing typed by the studio's team: what to say, never the message itself. */
    title: z.string().trim().min(1).max(500),
    note: z.string().trim().max(4000).nullish(),
    as_of: isoDateTime.optional(),
    /** Unknown or absent → `manual` (a draft): a new kind must never be sent by surprise. */
    kind: z.string().trim().max(60).optional(),
    appointment_start_at: isoDateTime.nullish(),
    professional_first_name: z.string().trim().max(80).nullish(),
    /**
     * `kind: "charge"` only. Typed loosely on purpose: `chargeNoticeOf` checks them, and any
     * problem is a 422 `invalid_charge` naming the field, never a generic 400.
     */
    charge_link: z.unknown().optional(),
    charge_due_date: z.unknown().optional(),
    charge_amount_cents: z.unknown().optional(),
  })
  .passthrough();
export type MiraeReminderMessageInput = z.infer<typeof miraeReminderMessageSchema>;

export type ReminderOutcome =
  /** An agent draft was queued for the inbox. */
  | "drafted"
  /** The agent's automatic send was queued (the send gate still applies). */
  | "scheduled"
  /** This delivery key was drafted before: nothing created. */
  | "already_drafted"
  /** The agent already has a live scheduled return for this person: nothing created. */
  | "already_handled"
  /** No contact (or no WhatsApp conversation) with this phone. */
  | "contact_not_found"
  /** The contact opted out (`contacts.is_blocked`). */
  | "contact_blocked"
  /** The organization turned reminder messages off: 422. */
  | "disabled"
  /** A charge notice whose link, due date or amount is missing or invalid: 422. */
  | "invalid_charge";

export interface ReminderResult {
  outcome: ReminderOutcome;
  conversationId?: string;
  cronJobId?: string;
  delivery?: "draft" | "auto";
  /** `scheduled` answered again for a key already scheduled: nothing new was created. */
  replayed?: boolean;
  /** `invalid_charge` only: which fields failed. */
  invalidFields?: string[];
}

/** Pure: the organization's setting, with anything unknown falling back to the default. */
export function reminderDeliveryOf(settings: unknown): MiraeReminderDelivery {
  const raw = (settings as { mirae_reminder_delivery?: unknown } | null)?.mirae_reminder_delivery;
  return (MIRAE_REMINDER_DELIVERY_MODES as readonly unknown[]).includes(raw)
    ? (raw as MiraeReminderDelivery)
    : DEFAULT_REMINDER_DELIVERY;
}

/**
 * Mirae's own spelling (`connector.ts`, ADR-084: `evaluation` | `first_class`) and the long one
 * this CRM names its kinds by. Both are accepted.
 */
const KIND_ALIASES: Record<string, MiraeReminderKind> = {
  evaluation: "evaluation_confirmation",
  first_class: "first_class_confirmation",
  charge: "charge_notice",
};

export type ChargeNotice = NonNullable<MiraeReminderPayload["charge"]>;

/** R$ 100.000,00: a studio installment above this is a mistake, never a message to a student. */
export const MAX_CHARGE_AMOUNT_CENTS = 10_000_000;
/** Mirae generates the charge 7 days before the due date; the notice never goes further out. */
export const MAX_DUE_DATE_AHEAD_DAYS = 45;

/** Pure: a real calendar day written `YYYY-MM-DD`. */
function isCalendarDate(raw: unknown): raw is string {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const at = new Date(`${raw}T00:00:00.000Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === raw;
}

/**
 * Pure: a due date the notice can still be about: not before yesterday (UTC, so a call late in
 * the Brazilian evening is not refused) and at most `MAX_DUE_DATE_AHEAD_DAYS` ahead.
 */
function isReasonableDueDate(raw: string, now: Date): boolean {
  const day = Date.parse(`${raw}T00:00:00.000Z`);
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const DAY = 24 * 60 * 60_000;
  return day >= today - DAY && day <= today + MAX_DUE_DATE_AHEAD_DAYS * DAY;
}

/**
 * Pure: the charge a `charge` reminder carries, or the fields that are missing or invalid. Every
 * other kind has no charge (`null`), whatever charge fields came along.
 */
export function chargeNoticeOf(
  input: Pick<MiraeReminderMessageInput, "kind" | "charge_link" | "charge_due_date" | "charge_amount_cents">,
  now: Date,
): { ok: true; charge: ChargeNotice | null } | { ok: false; invalidFields: string[] } {
  if (reminderKindOf(input.kind) !== CHARGE_NOTICE_KIND) return { ok: true, charge: null };
  const link = asaasInvoiceLinkOf(input.charge_link);
  const dueDate = input.charge_due_date;
  const validDueDate = isCalendarDate(dueDate) && isReasonableDueDate(dueDate, now);
  const amount = input.charge_amount_cents;
  const validAmount =
    typeof amount === "number" && Number.isSafeInteger(amount) && amount > 0 && amount <= MAX_CHARGE_AMOUNT_CENTS;
  if (link === null || !validDueDate || !validAmount || !isCalendarDate(dueDate)) {
    return {
      ok: false,
      invalidFields: [
        ...(link === null ? ["charge_link"] : []),
        ...(validDueDate ? [] : ["charge_due_date"]),
        ...(validAmount ? [] : ["charge_amount_cents"]),
      ],
    };
  }
  return { ok: true, charge: { link, due_date: dueDate, amount_cents: amount } };
}

/** Pure: Mirae's kind, or `manual` for anything this CRM does not know. */
export function reminderKindOf(raw: string | undefined): MiraeReminderKind {
  // Own keys only: `"toString" in {}` is true.
  if (raw && Object.hasOwn(KIND_ALIASES, raw)) return KIND_ALIASES[raw]!;
  return (MIRAE_REMINDER_KINDS as readonly string[]).includes(raw ?? "")
    ? (raw as MiraeReminderKind)
    : "manual";
}

/** A return due after this instant does not compete with the reminder. */
export const LIVE_RETURN_HORIZON_MS = 24 * 60 * 60_000;

/**
 * Pure: until when another return counts as "the person already gets a message". Up to the
 * appointment, when known (a return due next week must not swallow tomorrow's confirmation),
 * else the next 24 hours.
 */
export function liveReturnHorizon(appointmentStartAt: string | null | undefined, now: Date): Date {
  const at = appointmentStartAt ? Date.parse(appointmentStartAt) : Number.NaN;
  return Number.isNaN(at) ? new Date(now.getTime() + LIVE_RETURN_HORIZON_MS) : new Date(at);
}

/** The contact lock every reminder writer takes (endpoint and requeue). */
export async function lockReminderContact(
  db: Pick<pg.PoolClient, "query">,
  orgId: string,
  contactId: string,
): Promise<void> {
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `mirae_reminder_contact:${orgId}:${contactId}`,
  ]);
}

/**
 * Another return due before `before`: live in `cron_jobs`, or a return turn queued (`run_after`
 * before it, e.g. deferred to the send window) or running in `job_queue`. A charge notice does not
 * count: it talks about a payment, not about the appointment the reminder is for.
 */
export async function hasLiveReturnBefore(
  db: Pick<pg.PoolClient, "query">,
  orgId: string,
  contactId: string,
  before: Date,
): Promise<boolean> {
  const { rows } = await db.query<{ live: boolean }>(
    `select (
       exists (select 1 from cron_jobs
                where organization_id = $1 and contact_id = $2
                  and kind = 'at' and job_kind = 'followup_turn' and enabled = true
                  and next_run_at < $3
                  and (payload->'mirae_reminder'->>'kind') is distinct from $4)
       or exists (select 1 from job_queue
                   where organization_id = $1 and contact_id = $2
                     and kind = 'followup_turn'
                     and (status = 'running' or (status = 'pending' and run_after < $3))
                     and (payload->'mirae_reminder'->>'kind') is distinct from $4)
     ) as live`,
    [orgId, contactId, before, CHARGE_NOTICE_KIND],
  );
  return rows[0]?.live === true;
}

/**
 * Pure: may this kind go out without a person, on `auto`? A confirmation only with its appointment
 * time (it is checked in Mirae before sending); a charge notice always (Mirae re-checks the charge
 * before calling).
 */
export function mayAutoSend(kind: MiraeReminderKind, hasAppointmentTime: boolean): boolean {
  return kind === CHARGE_NOTICE_KIND || (CONFIRMATION_KINDS.has(kind) && hasAppointmentTime);
}

/** Pure: draft or automatic send for this reminder. */
export function deliveryFor(
  setting: Exclude<MiraeReminderDelivery, "off">,
  kind: MiraeReminderKind,
  humanInCharge: boolean,
  /** The appointment time is known: without it nothing can be checked in Mirae before sending. */
  hasAppointmentTime: boolean,
): "draft" | "auto" {
  return setting === "auto" && mayAutoSend(kind, hasAppointmentTime) && !humanInCharge ? "auto" : "draft";
}

export function deliveryKeyOf(input: Pick<MiraeReminderMessageInput, "delivery_key" | "reminder_id">): string {
  return input.delivery_key ?? input.reminder_id;
}

// ---------------------------------------------------------------------------
// Database port (narrow, so the rule is tested without Postgres)
// ---------------------------------------------------------------------------

export interface ReminderContactRow {
  id: string;
  phone_number: string | null;
  is_blocked: boolean | null;
}

export interface ReminderDbTx {
  readSettings(orgId: string): Promise<unknown>;
  findByKey(
    orgId: string,
    key: string,
  ): Promise<{ cronJobId: string; delivery: "draft" | "auto"; conversationId: string | null } | null>;
  /** Live (not anonymized, not merged) contacts of this organization with one of these phones. */
  findContacts(orgId: string, phones: readonly string[]): Promise<ReminderContactRow[]>;
  /** The contact's latest 1:1 conversation on a channel that is not archived. */
  findConversation(
    orgId: string,
    contactId: string,
  ): Promise<{ id: string; channelSessionId: string } | null>;
  /** Serializes every reminder of this contact until the transaction ends. */
  lockContact(orgId: string, contactId: string): Promise<void>;
  /** Another return due before `before` (`hasLiveReturnBefore`). */
  hasLiveReturn(orgId: string, contactId: string, before: Date): Promise<boolean>;
  /** A person handles this contact: `force_human`, "always human", internal tag, silenced bot. */
  humanInCharge(orgId: string, contactId: string): Promise<boolean>;
  beginService(orgId: string, contactId: string, channelSessionId: string): Promise<ServiceBoundary>;
  insertTurn(
    orgId: string,
    input: { contactId: string; runAt: Date; payload: Record<string, unknown> },
  ): Promise<string>;
}

export interface ReminderDb {
  /** Runs `fn` in one transaction holding a lock on (organization, key). */
  withKeyLock<T>(orgId: string, key: string, fn: (tx: ReminderDbTx) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

export async function queueMiraeReminderMessage(
  db: ReminderDb,
  ctx: { organizationId: string; now: Date },
  input: MiraeReminderMessageInput,
): Promise<ReminderResult> {
  const key = deliveryKeyOf(input);
  // A charge without a valid link, due date and amount is refused before anything is read.
  const charge = chargeNoticeOf(input, ctx.now);
  if (!charge.ok) return { outcome: "invalid_charge", invalidFields: charge.invalidFields };
  return db.withKeyLock(ctx.organizationId, key, async (tx) => {
    const setting = reminderDeliveryOf(await tx.readSettings(ctx.organizationId));
    if (setting === "off") return { outcome: "disabled" };

    // 1. One message per delivery key, ever: a retry answers what the first call did.
    const seen = await tx.findByKey(ctx.organizationId, key);
    if (seen) {
      const conversation = seen.conversationId ? { conversationId: seen.conversationId } : {};
      return seen.delivery === "auto"
        ? { outcome: "scheduled", replayed: true, delivery: "auto", cronJobId: seen.cronJobId, ...conversation }
        : { outcome: "already_drafted", delivery: "draft", cronJobId: seen.cronJobId, ...conversation };
    }

    // 2. The contact and the conversation, by phone. Mirae stores it masked, often without 55.
    const phone = normalizePhoneBR(input.phone);
    if (!phone) return { outcome: "contact_not_found" };
    const contact = escolherContatoCanonico(
      await tx.findContacts(ctx.organizationId, phoneLookupVariants(phone)),
      phone,
    );
    if (!contact) return { outcome: "contact_not_found" };
    const conversation = await tx.findConversation(ctx.organizationId, contact.id);
    if (!conversation) return { outcome: "contact_not_found" };

    // 3. Opt-out wins over everything that follows.
    if (contact.is_blocked) return { outcome: "contact_blocked", conversationId: conversation.id };

    // 4. The agent already promised to come back, or another reminder is on its way: one
    // message, not two. The contact lock makes two reminders with different keys see each other.
    // A charge notice still goes: the payment link must reach the person.
    await tx.lockContact(ctx.organizationId, contact.id);
    const kind = reminderKindOf(input.kind);
    if (kind !== CHARGE_NOTICE_KIND) {
      const horizon = liveReturnHorizon(input.appointment_start_at, ctx.now);
      if (await tx.hasLiveReturn(ctx.organizationId, contact.id, horizon)) {
        return { outcome: "already_handled", conversationId: conversation.id };
      }
    }

    // 5. Queue the turn.
    const hasTime = Boolean(input.appointment_start_at);
    const delivery = deliveryFor(
      setting,
      kind,
      setting === "auto" && mayAutoSend(kind, hasTime)
        ? await tx.humanInCharge(ctx.organizationId, contact.id)
        : false,
      hasTime,
    );
    const boundary = await tx.beginService(ctx.organizationId, contact.id, conversation.channelSessionId);
    const reminder: MiraeReminderPayload = {
      delivery_key: key,
      reminder_id: input.reminder_id,
      delivery,
      kind,
      title: input.title,
      note: input.note ?? null,
      student_name: input.studentName || null,
      // The phone as Mirae has it: the pre-check retries with it when the CRM's spelling finds
      // nobody in Mirae (9th digit).
      mirae_phone: input.phone.replace(/\D/g, "") || null,
      // A charge has no appointment: a time sent along would make the turn drop it as "too late".
      appointment_start_at: charge.charge ? null : (input.appointment_start_at ?? null),
      professional_first_name: input.professional_first_name ?? null,
      ...(charge.charge ? { charge: charge.charge } : {}),
    };
    const cronJobId = await tx.insertTurn(ctx.organizationId, {
      contactId: contact.id,
      runAt: ctx.now,
      payload: {
        source: MIRAE_REMINDER_SOURCE,
        // `reason` is what the follow-up queue and the timeline show for a return.
        reason: `Lembrete do Mirae: ${input.title}`.slice(0, 500),
        // No `promise` key: the turn's payload schema reads it as an optional string, never null.
        promised_at: ctx.now.toISOString(),
        mirae_reminder: reminder,
        conversation_id: boundary.conversation_id,
        service_boundary: boundary,
      },
    });
    return {
      outcome: delivery === "auto" ? "scheduled" : "drafted",
      delivery,
      cronJobId,
      conversationId: boundary.conversation_id,
    };
  });
}

// ---------------------------------------------------------------------------
// The Postgres adapter
// ---------------------------------------------------------------------------

/**
 * `ReminderDb` over `pg.Pool`. Every query filters `organization_id` (the token's): the pool
 * connects as the database owner and RLS does not apply.
 */
export function reminderDbPg(
  pool: pg.Pool,
  humanInCharge: (orgId: string, contactId: string) => Promise<boolean>,
): ReminderDb {
  return {
    async withKeyLock(orgId, key, fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `mirae_reminder:${orgId}:${key}`,
        ]);
        const result = await fn(txOver(client, humanInCharge));
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

function txOver(
  client: pg.PoolClient,
  humanInCharge: (orgId: string, contactId: string) => Promise<boolean>,
): ReminderDbTx {
  return {
    async readSettings(orgId) {
      const { rows } = await client.query<{ settings: unknown }>(
        "select settings from organizations where id = $1",
        [orgId],
      );
      return rows[0]?.settings ?? null;
    },

    async findByKey(orgId, key) {
      const { rows } = await client.query<{
        id: string;
        delivery: string | null;
        conversation_id: string | null;
      }>(
        `select id, payload->'mirae_reminder'->>'delivery' as delivery,
                payload->>'conversation_id' as conversation_id
           from cron_jobs
          where organization_id = $1 and kind = 'at' and job_kind = 'followup_turn'
            and payload->>'source' = $2
            and payload->'mirae_reminder'->>'delivery_key' = $3
          order by created_at
          limit 1`,
        [orgId, MIRAE_REMINDER_SOURCE, key],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        cronJobId: row.id,
        delivery: row.delivery === "auto" ? "auto" : "draft",
        conversationId: row.conversation_id,
      };
    },

    async findContacts(orgId, phones) {
      if (phones.length === 0) return [];
      const { rows } = await client.query<ReminderContactRow>(
        `select id, phone_number, is_blocked
           from contacts
          where organization_id = $1 and phone_number = any($2::text[])
            and is_merged_into is null and not coalesce(is_anonymized, false)
          limit 4`,
        [orgId, phones],
      );
      return rows;
    },

    async findConversation(orgId, contactId) {
      const { rows } = await client.query<{ id: string; channel_session_id: string }>(
        `select c.id, c.channel_session_id
           from conversations c
           join channel_sessions cs on cs.id = c.channel_session_id and cs.organization_id = c.organization_id
          where c.organization_id = $1 and c.contact_id = $2 and not c.is_group
            and cs.archived_at is null
          order by c.last_message_at desc nulls last, c.created_at desc
          limit 1`,
        [orgId, contactId],
      );
      const row = rows[0];
      return row ? { id: row.id, channelSessionId: row.channel_session_id } : null;
    },

    lockContact: (orgId, contactId) => lockReminderContact(client, orgId, contactId),

    hasLiveReturn: (orgId, contactId, before) => hasLiveReturnBefore(client, orgId, contactId, before),

    humanInCharge,

    async beginService(orgId, contactId, channelSessionId) {
      const { rows } = await client.query<{ b: unknown }>(
        "select public.fn_service_begin($1, $2, $3) as b",
        [orgId, contactId, channelSessionId],
      );
      const b = parseServiceBoundary(rows[0]?.b);
      if (!b) throw new Error("mirae_reminder_service_boundary_invalid");
      // The identity only, as `fn_followup_*` stores it: status and timestamps are not part of it.
      return {
        organization_id: b.organization_id,
        contact_id: b.contact_id,
        conversation_id: b.conversation_id,
        service_revision: b.service_revision,
        demanda_id: b.demanda_id,
        demanda_revision: b.demanda_revision,
      };
    },

    async insertTurn(orgId, input) {
      const { rows } = await client.query<{ id: string }>(
        `insert into cron_jobs (organization_id, contact_id, kind, job_kind, payload, next_run_at)
         values ($1, $2, 'at', 'followup_turn', $3, $4)
         returning id`,
        [orgId, input.contactId, input.payload, input.runAt],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error("mirae_reminder_insert_failed");
      return id;
    },
  };
}

/** The conversation in the CRM, as a link Mirae shows as a button (same origin as the CRM). */
export function conversationUrl(appUrl: string, conversationId: string): string {
  return `${appUrl.replace(/\/+$/, "")}/app/inbox/${conversationId}`;
}
