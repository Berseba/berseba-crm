import type { Pool } from "pg";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import { cancelJob, failJob, type JobRow } from "@/lib/agent-engine/queue/queue";
import { avisarRespostaDeCasoObsoleto } from "@/lib/atendimento/aviso-caso-obsoleto";
import { descartarFollowupObsoleto } from "@/lib/atendimento/descartar-followup-obsoleto";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import { requeueStaleMiraeReminder } from "@/lib/integrations/mirae/reminder-requeue";

/** Disposição usada pelo catch real do worker, sem iniciar seus loops no teste.
 * O lease original protege toda escrita; nunca cancela o trabalho de outro ciclo.
 */
export async function disporJobAposFalha(
  pool: Pool,
  job: JobRow,
  workerId: string,
  error: unknown,
  terminal: boolean,
  log: Pick<Logger, "warn">,
): Promise<void> {
  if (
    error instanceof StaleServiceBoundaryError &&
    job.kind === "case_reply_turn" &&
    typeof job.payload.case_id === "string"
  ) {
    await avisarRespostaDeCasoObsoleto(pool, job.organization_id, job.payload.case_id);
  }
  if (error instanceof StaleServiceBoundaryError && job.kind === "followup_turn") {
    await descartarFollowupObsoleto(pool, job, workerId, log);
    // Berseba: a Mirae reminder is queued again on the current boundary, never lost in silence.
    await requeueStaleMiraeReminder(pool, job, new Date()).catch((err: unknown) => {
      log.warn("mirae_reminder_requeue_failed", {
        job_id: job.id,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    });
  } else if (terminal) {
    const reason = error instanceof Error ? error.message : String(error);
    await cancelJob(pool, job.id, workerId, (reason.split("\n", 1)[0] ?? "").slice(0, 300), claimOfJob(job)?.acquired_at);
  } else {
    await failJob(pool, job.id, workerId, error, claimOfJob(job)?.acquired_at);
  }
}
