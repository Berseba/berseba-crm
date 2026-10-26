/**
 * Berseba: an evaluation booked in Mirae moves the client's card, deterministically.
 *
 * Fiore Pilates' "Novos alunos" funnel has a stage with `agent_stage_hint = 'negotiating'`
 * ("Avaliação agendada"). Before Mirae, the agent marked `negotiating` itself with
 * `update_lead_state` once the team confirmed the evaluation. Now `mirae_book` confirms it, so the
 * handler does what that tool would have done, on the same two paths and nothing new:
 *
 *  1. the agent's own funnel (`lead_state`, the harness of `lib/agent-engine/agent/lead-state.ts`)
 *     goes to `negotiating`, with its transition row. Without this, a later `contacted` or
 *     `qualified` from the model would be a valid harness step and its mirror would pull the
 *     card back out of "Avaliação agendada";
 *  2. the card follows through `sincronizaEstagioDoAgente`, the same function the
 *     `update_lead_state` mirror calls, with the funnels of the agent's PUBLISHED version as
 *     scope. That is how the bridge's funnel gate is respected: `mirae_book` has no `lead_id`
 *     nor `contact_id` argument for `podeChamarFerramenta` to check, so it is declared
 *     `sem_funil` there and scoped here.
 *
 * Never throws and never undoes the booking: the evaluation is already in Mirae. Every outcome
 * is logged (no phone, no name), and the result is returned for the tests.
 */
import type { McpContext } from "@/lib/mcp/types";
import { sincronizaEstagioDoAgente } from "@/lib/leads/agent-stage-sync";
import { logger } from "@/lib/logger";

const PASSO = "negotiating";
/** Harness steps past which a booking does not move the agent's funnel. */
const TERMINAL = new Set(["negotiating", "won", "lost"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EvaluationStageResult {
  harness: "advanced" | "already_there" | "failed";
  card: string;
}

/** The funnels the agent's published version may write; `[]` (none) when unknown. */
async function publishedScope(ctx: McpContext): Promise<readonly string[]> {
  const agentId = ctx.actor.type === "ai_agent" ? ctx.actor.agent_id : undefined;
  if (!agentId) return [];
  const { data: agent, error } = await ctx.supabase
    .from("ai_agents")
    .select("published_version_id")
    .eq("organization_id", ctx.organizationId)
    .eq("id", agentId)
    .maybeSingle<{ published_version_id: string | null }>();
  if (error || !agent?.published_version_id) return [];
  const { data: version, error: versionError } = await ctx.supabase
    .from("ai_agent_versions")
    .select("pipeline_ids")
    .eq("organization_id", ctx.organizationId)
    .eq("id", agent.published_version_id)
    .maybeSingle<{ pipeline_ids: string[] | null }>();
  if (versionError) return [];
  return version?.pipeline_ids ?? [];
}

async function advanceHarness(
  ctx: McpContext,
  contactId: string,
): Promise<EvaluationStageResult["harness"]> {
  const { data, error } = await ctx.supabase
    .from("lead_state")
    .select("stage")
    .eq("organization_id", ctx.organizationId)
    .eq("contact_id", contactId)
    .maybeSingle<{ stage: string }>();
  if (error) return "failed";
  const from = data?.stage ?? "new";
  if (TERMINAL.has(from)) return "already_there";
  const { error: upsertError } = await ctx.supabase.from("lead_state").upsert(
    {
      organization_id: ctx.organizationId,
      contact_id: contactId,
      stage: PASSO,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,contact_id" },
  );
  if (upsertError) return "failed";
  const { error: transitionError } = await ctx.supabase.from("lead_state_transitions").insert({
    organization_id: ctx.organizationId,
    contact_id: contactId,
    job_id: ctx.sourceJobId && UUID.test(ctx.sourceJobId) ? ctx.sourceJobId : null,
    from_stage: from,
    to_stage: PASSO,
    reason: "mirae_book: avaliação marcada no Mirae",
  });
  // The step itself is written; a missing history row is only logged.
  if (transitionError)
    logger.warn("mirae: lead_state transition row not written", {
      organization_id: ctx.organizationId,
      error: transitionError.message,
    });
  return "advanced";
}

export async function moveCardOnEvaluationBooked(ctx: McpContext): Promise<EvaluationStageResult> {
  const contactId = ctx.contatoDoTurno;
  if (!contactId) return { harness: "failed", card: "sem_contato_do_turno" };
  try {
    const harness = await advanceHarness(ctx, contactId);
    const sync = await sincronizaEstagioDoAgente(ctx.supabase, {
      organizationId: ctx.organizationId,
      contactId,
      passo: PASSO,
      escopoDeFunis: await publishedScope(ctx),
    });
    const result = { harness, card: sync.motivo };
    const log = { organization_id: ctx.organizationId, lead_id: sync.leadId, ...result };
    if (sync.moveu || sync.motivo === "ja_esta_la") {
      logger.info("mirae: evaluation booked, funnel sync", log);
    } else {
      logger.warn("mirae: evaluation booked, card not moved", log);
    }
    return result;
  } catch (err) {
    logger.warn("mirae: evaluation booked, funnel sync failed", {
      organization_id: ctx.organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { harness: "failed", card: "erro" };
  }
}
