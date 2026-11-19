/**
 * Berseba: a Mirae reminder whose service boundary went stale is queued again, never dropped in
 * silence (berseba-crm#127).
 *
 * The reminder carries the conversation's service boundary from the moment it was queued (the
 * worker refuses a `followup_turn` without a current one, `withServiceJob`). When the person
 * writes in between (a new demand, a reopened conversation), the boundary is stale and the
 * worker discards the turn (`descartarFollowupObsoleto`). For a generic return that is right;
 * for a Mirae reminder it would lose a message Mirae was told is on its way, and Mirae cannot
 * recall it. So `disporJobAposFalha` hands the stale reminder here, which reads the
 * conversation's CURRENT boundary (`fn_service_begin`) and queues the same reminder again, due
 * now. The turn still checks the appointment in Mirae and the conversation before writing.
 *
 * The same rules as the endpoint, in one transaction: the contact lock, and no requeue when
 * another return is due before the appointment (the person gets that one). Bounded: at most
 * `MAX_REQUEUES` times per reminder, and never for one already less than an hour from the
 * appointment. Every give-up ends in a notice to the team. Idempotent per discarded job.
 */
import type pg from "pg";

import {
  avisarLembreteQueNaoSaiu,
  CHARGE_NOTICE_KIND,
  chegaTardeDemais,
  lembreteDoMirae,
  MIRAE_REMINDER_SOURCE,
} from "@/lib/agent-engine/agent/mirae-reminder-turn.berseba";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { parseServiceBoundary } from "@/lib/atendimento/fronteira";

import { hasLiveReturnBefore, liveReturnHorizon, lockReminderContact } from "./reminder-message";

export const MAX_REQUEUES = 3;

export type RequeueResult =
  | "not_mirae"
  | "requeued"
  | "already_requeued"
  | "already_handled"
  | "too_late"
  | "exhausted";

export async function requeueStaleMiraeReminder(
  pool: Pick<pg.Pool, "connect">,
  job: Pick<JobRow, "id" | "organization_id" | "contact_id" | "payload">,
  now: Date,
  avisar: typeof avisarLembreteQueNaoSaiu = avisarLembreteQueNaoSaiu,
): Promise<RequeueResult> {
  if (!lembreteDoMirae(job.payload) || !job.contact_id) return "not_mirae";
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await requeueInTx(client, job, now, avisar);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function requeueInTx(
  pool: Pick<pg.PoolClient, "query">,
  job: Pick<JobRow, "id" | "organization_id" | "contact_id" | "payload">,
  now: Date,
  avisar: typeof avisarLembreteQueNaoSaiu,
): Promise<RequeueResult> {
  const reminder = lembreteDoMirae(job.payload)!;
  const contactId = job.contact_id!;
  const orgId = job.organization_id;
  const conversationId =
    typeof job.payload.conversation_id === "string" ? job.payload.conversation_id : null;

  const { rows: done } = await pool.query(
    `select 1 from cron_jobs
      where organization_id = $1 and contact_id = $2 and payload->>'requeued_from' = $3
      limit 1`,
    [orgId, contactId, job.id],
  );
  if (done.length > 0) return "already_requeued";

  if (chegaTardeDemais(reminder, now)) {
    await avisar(pool, {
      tenantId: orgId,
      conversationId,
      reminder,
      motivo: "A conversa mudou antes do envio e já não havia tempo para mandar o lembrete.",
    });
    return "too_late";
  }
  const requeues = typeof job.payload.mirae_requeues === "number" ? job.payload.mirae_requeues : 0;
  if (requeues >= MAX_REQUEUES) {
    await avisar(pool, {
      tenantId: orgId,
      conversationId,
      reminder,
      motivo: "A conversa mudou várias vezes antes do envio e o lembrete parou de ser refeito.",
    });
    return "exhausted";
  }

  // Same rule as the endpoint: one message, not two. A charge notice still goes: the payment link
  // must reach the person.
  await lockReminderContact(pool, orgId, contactId);
  if (
    reminder.kind !== CHARGE_NOTICE_KIND &&
    (await hasLiveReturnBefore(pool, orgId, contactId, liveReturnHorizon(reminder.appointment_start_at, now)))
  ) {
    await avisar(pool, {
      tenantId: orgId,
      conversationId,
      reminder,
      motivo: "A conversa mudou antes do envio, e outro retorno da assistente já vai falar com a pessoa antes do horário.",
    });
    return "already_handled";
  }

  // The current boundary, on the same channel when the conversation still exists.
  const { rows: channel } = await pool.query<{ channel_session_id: string }>(
    "select channel_session_id from conversations where organization_id = $1 and id = $2",
    [orgId, conversationId],
  );
  const { rows } = await pool.query<{ b: unknown }>(
    "select public.fn_service_begin($1, $2, $3) as b",
    [orgId, contactId, channel[0]?.channel_session_id ?? null],
  );
  const b = parseServiceBoundary(rows[0]?.b);
  if (!b) throw new Error("mirae_reminder_service_boundary_invalid");
  const boundary = {
    organization_id: b.organization_id,
    contact_id: b.contact_id,
    conversation_id: b.conversation_id,
    service_revision: b.service_revision,
    demanda_id: b.demanda_id,
    demanda_revision: b.demanda_revision,
  };
  await pool.query(
    `insert into cron_jobs (organization_id, contact_id, kind, job_kind, payload, next_run_at)
     values ($1, $2, 'at', 'followup_turn', $3, $4)`,
    [
      orgId,
      contactId,
      {
        source: MIRAE_REMINDER_SOURCE,
        reason: job.payload.reason,
        promised_at: job.payload.promised_at,
        mirae_reminder: reminder,
        conversation_id: boundary.conversation_id,
        service_boundary: boundary,
        requeued_from: job.id,
        mirae_requeues: requeues + 1,
      },
      now,
    ],
  );
  return "requeued";
}
