/**
 * Berseba: did the Mirae charge notice reach the person? (berseba-crm#127)
 *
 * After the automatic turn of a charge notice, `runMiraeReminderTurn`
 * (`lib/agent-engine/agent/mirae-reminder-turn.berseba.ts`) reads what actually went out, so a
 * charge the send gate vetoed, or one sent with another amount or due date, opens a notice for
 * the team instead of dying in silence.
 */
import type pg from "pg";

/**
 * The bodies of this conversation's outbound messages that carry the charge link, newest first.
 * The Asaas link identifies the invoice, so any time counts: a retried job whose first run already
 * sent it finds it here. Filters by the job's organization: the worker's pool bypasses RLS.
 */
export async function sentChargeMessages(
  pool: Pick<pg.Pool, "query">,
  input: { tenantId: string; conversationId: string; link: string },
): Promise<string[]> {
  const { rows } = await pool.query<{ body: string }>(
    `select body from messages
      where organization_id = $1 and conversation_id = $2 and direction = 'outbound'
        and status <> 'failed' and strpos(coalesce(body, ''), $3) > 0
      order by created_at desc
      limit 5`,
    [input.tenantId, input.conversationId, input.link],
  );
  return rows.map((r) => r.body);
}
