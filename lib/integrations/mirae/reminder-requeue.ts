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
 * Bounded: at most `MAX_REQUEUES` times per reminder, and never for one already less than an hour
 * from the appointment; both end in a notice to the team. Idempotent per discarded job.
 */
import type pg from "pg";

import {
  avisarLembreteQueNaoSaiu,
  chegaTardeDemais,
  lembreteDoMirae,
  MIRAE_REMINDER_SOURCE,
} from "@/lib/agent-engine/agent/mirae-reminder-turn.berseba";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { parseServiceBoundary } from "@/lib/atendimento/fronteira";

export const MAX_REQUEUES = 3;

export type RequeueResult = "not_mirae" | "requeued" | "already_requeued" | "too_late" | "exhausted";

export async function requeueStaleMiraeReminder(
  pool: Pick<pg.Pool, "query">,
  job: Pick<JobRow, "id" | "organization_id" | "contact_id" | "payload">,
  now: Date,
  avisar: typeof avisarLembreteQueNaoSaiu = avisarLembreteQueNaoSaiu,
): Promise<RequeueResult> {
  const reminder = lembreteDoMirae(job.payload);
  if (!reminder || !job.contact_id) return "not_mirae";
  const orgId = job.organization_id;
  const conversationId =
    typeof job.payload.conversation_id === "string" ? job.payload.conversation_id : null;

  const { rows: done } = await pool.query(
    `select 1 from cron_jobs
      where organization_id = $1 and contact_id = $2 and payload->>'requeued_from' = $3
      limit 1`,
    [orgId, job.contact_id, job.id],
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

  // The current boundary, on the same channel when the conversation still exists.
  const { rows: channel } = await pool.query<{ channel_session_id: string }>(
    "select channel_session_id from conversations where organization_id = $1 and id = $2",
    [orgId, conversationId],
  );
  const { rows } = await pool.query<{ b: unknown }>(
    "select public.fn_service_begin($1, $2, $3) as b",
    [orgId, job.contact_id, channel[0]?.channel_session_id ?? null],
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
      job.contact_id,
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
