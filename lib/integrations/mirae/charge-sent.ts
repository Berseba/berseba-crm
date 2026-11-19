/**
 * Berseba: did the Mirae charge notice reach the person? (berseba-crm#127)
 *
 * After the automatic turn of a charge notice, `runMiraeReminderTurn`
 * (`lib/agent-engine/agent/mirae-reminder-turn.berseba.ts`) reads what actually went out, so a
 * charge the send gate vetoed, or one sent with another amount or due date, opens a notice for
 * the team instead of dying in silence.
 */
import type pg from "pg";

/** Clock skew allowed between the worker and the database when reading "this turn's" messages. */
const SKEW_MS = 10_000;

/**
 * What went out to the person about this charge, as texts to check. The agent's reply may be split
 * into several WhatsApp messages (one per paragraph), so every outbound message of this
 * conversation since the turn started is joined, in order, into ONE text. Older messages carrying
 * the link (a retried job whose first run already sent it) come one by one: the Asaas link
 * identifies the invoice. Filters by the job's organization: the worker's pool bypasses RLS.
 */
export async function sentChargeMessages(
  pool: Pick<pg.Pool, "query">,
  input: { tenantId: string; conversationId: string; link: string; since: Date },
): Promise<string[]> {
  const since = new Date(input.since.getTime() - SKEW_MS);
  const { rows } = await pool.query<{ body: string | null; this_turn: boolean }>(
    `select body, created_at >= $4 as this_turn from messages
      where organization_id = $1 and conversation_id = $2 and direction = 'outbound'
        and status <> 'failed'
        and (created_at >= $4 or strpos(coalesce(body, ''), $3) > 0)
      order by created_at, id
      limit 40`,
    [input.tenantId, input.conversationId, input.link, since],
  );
  const thisTurn = rows.filter((r) => r.this_turn).map((r) => r.body ?? "");
  const older = rows.filter((r) => !r.this_turn).map((r) => r.body ?? "");
  return [...(thisTurn.length > 0 ? [thisTurn.join("\n\n")] : []), ...older].filter((t) =>
    t.includes(input.link),
  );
}
