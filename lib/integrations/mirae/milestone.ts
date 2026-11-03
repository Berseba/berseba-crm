/**
 * Berseba: a milestone in Mirae moves the person's card (Mirae ADR-073, "ponte ②").
 *
 * Mirae owns the facts (evaluation booked, attended, missed, enrolled) and the studio's map
 * "milestone → stage" (its Integrações › CRM screen). It calls `POST /api/v1/mirae/milestones`
 * from a queue with retries, so this file answers the same thing for the same call:
 *
 *  - the stage must belong to the named funnel of this organization, and match the milestone
 *    (`enrolled` → the won stage; every other one → an open stage). A wrong map is a 422 that
 *    Mirae shows on its screen, never a guess;
 *  - the contact is found by phone (both spellings of the Brazilian 9th digit); a personal or
 *    anonymized contact is left alone. Mirae never creates a contact nor a card;
 *  - the card is the contact's open lead in that funnel (`resolveActiveLeadForContact`, the same
 *    choice as everywhere else); with none open, only an enrollment reopens the latest lost one
 *    (ADR-073 §4). A card already in the stage is not touched, so a repeated call is a no-op;
 *  - the move is `moveLeadHandler`, the rule every non-board writer follows (required fields,
 *    won/lost reason, reopening, optimistic lock, timeline, `lead.stage_changed`, audit). A
 *    business refusal comes back as an outcome, not as an error to retry;
 *  - the agent's own funnel (`lead_state`) follows: `negotiating` for a visit, `won` for an
 *    enrollment. From `negotiating` the harness only allows `won`/`lost`, so the agent's hint
 *    mirror cannot pull the card back out of "Avaliação feita" or "Faltou".
 *
 * Logs carry ids and outcomes only, never the phone.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { moveLeadHandler } from "@/app/api/v1/leads/_handler";
import { ApiError } from "@/lib/api/types";
import { escolherContatoCanonico } from "@/lib/channels/contato-por-telefone";
import { normalizePhoneBR, phoneLookupVariants } from "@/lib/channels/phone-variants";
import { resolveActiveLeadForContact } from "@/lib/leads/active-lead";
import { logger } from "@/lib/logger";

import { advanceAgentFunnel } from "./evaluation-stage";

export const MIRAE_MILESTONES = ["evaluation_booked", "attended", "missed", "enrolled"] as const;
export type MiraeMilestone = (typeof MIRAE_MILESTONES)[number];

export const miraeMilestoneSchema = z
  .object({
    milestone: z.enum(MIRAE_MILESTONES),
    /** Any format; Mirae stores it with a mask. */
    phone: z.string().trim().min(8).max(40),
    pipeline_id: z.string().uuid(),
    stage_id: z.string().uuid(),
    /** When Mirae read the person's state; logged only. */
    as_of: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type MiraeMilestoneInput = z.infer<typeof miraeMilestoneSchema>;

/** Timeline text (the card's history is read by the studio's team). */
const TIMELINE_REASON: Record<MiraeMilestone, string> = {
  evaluation_booked: "Mirae: avaliação marcada",
  attended: "Mirae: presença na avaliação",
  missed: "Mirae: falta na avaliação",
  enrolled: "Mirae: matrícula",
};

export type MilestoneOutcome =
  /** The card moved to the stage. */
  | "moved"
  /** The card was already there: nothing written. */
  | "already_there"
  /** No contact with this phone: the person never talked on WhatsApp. */
  | "no_contact"
  /** A personal (team/family) or anonymized contact: never moved. */
  | "contact_excluded"
  /** The contact has no lead in this funnel. */
  | "no_open_lead"
  /** Two open leads in this funnel, tied: moving one would be a guess. */
  | "ambiguous"
  /** Only closed leads (won, or lost without an enrollment): left as is. */
  | "lead_closed"
  /** The lead rule refused the move (required field, reopening mode, reason…). */
  | "refused"
  /** Someone changed the card at the same moment: retry. */
  | "conflict"
  /** The map points to a stage that does not fit: fix it in Mirae. */
  | "invalid_stage"
  /** The database did not answer: retry. */
  | "unavailable";

export interface MilestoneResult {
  outcome: MilestoneOutcome;
  leadId?: string;
  /** The rule's code and sentence for `refused`/`invalid_stage`, or the error for `unavailable`. */
  code?: string;
  detail?: string;
  harness?: "advanced" | "already_there" | "failed";
}

interface LeadRow {
  id: string;
  organization_id: string;
  pipeline_id: string;
  stage_id: string;
  status: "open" | "won" | "lost";
  created_at: string;
  last_activity_at: string | null;
}

/** Pure: which lead this milestone moves, or why none. */
export function pickLead(
  leads: readonly LeadRow[],
  milestone: MiraeMilestone,
): { lead: LeadRow } | { outcome: "no_open_lead" | "ambiguous" | "lead_closed" } {
  if (leads.length === 0) return { outcome: "no_open_lead" };
  const route = resolveActiveLeadForContact([...leads]);
  if (route.routed) return { lead: leads.find((l) => l.id === route.leadId)! };
  if (route.reason !== "no_open_lead") return { outcome: "ambiguous" };
  // Nothing open. A won lead stays won; an enrollment reopens the latest lost one.
  const won = leads.find((l) => l.status === "won");
  if (milestone !== "enrolled" || won) return { outcome: "lead_closed" };
  const latestLost = [...leads]
    .filter((l) => l.status === "lost")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  return latestLost ? { lead: latestLost } : { outcome: "lead_closed" };
}

/** Pure: does this stage fit this milestone? */
export function stageFits(
  stage: { is_won: boolean | null; is_lost: boolean | null; is_archived: boolean | null },
  milestone: MiraeMilestone,
): boolean {
  if (stage.is_archived || stage.is_lost) return false;
  return milestone === "enrolled" ? stage.is_won === true : stage.is_won !== true;
}

export async function applyMiraeMilestone(
  admin: SupabaseClient,
  ctx: { organizationId: string; apiTokenId: string; requestId: string },
  input: MiraeMilestoneInput,
): Promise<MilestoneResult> {
  const result = await apply(admin, ctx, input);
  const log = {
    organization_id: ctx.organizationId,
    request_id: ctx.requestId,
    milestone: input.milestone,
    as_of: input.as_of,
    ...result,
  };
  if (result.outcome === "moved" || result.outcome === "already_there") {
    logger.info("mirae.milestone", log);
  } else {
    logger.warn("mirae.milestone_not_applied", log);
  }
  return result;
}

async function apply(
  admin: SupabaseClient,
  ctx: { organizationId: string; apiTokenId: string; requestId: string },
  input: MiraeMilestoneInput,
): Promise<MilestoneResult> {
  // 1. The map: the stage is in the named funnel of THIS organization and fits the milestone.
  const { data: stage, error: stageError } = await admin
    .from("crm_stages")
    .select("id, pipeline_id, is_won, is_lost, is_archived")
    .eq("organization_id", ctx.organizationId)
    .eq("id", input.stage_id)
    .maybeSingle<{
      id: string;
      pipeline_id: string;
      is_won: boolean | null;
      is_lost: boolean | null;
      is_archived: boolean | null;
    }>();
  if (stageError) return { outcome: "unavailable", detail: stageError.message };
  if (!stage || stage.pipeline_id !== input.pipeline_id) {
    return { outcome: "invalid_stage", code: "stage_not_in_pipeline" };
  }
  if (!stageFits(stage, input.milestone)) {
    return { outcome: "invalid_stage", code: "stage_does_not_fit_milestone" };
  }

  // 2. The contact, by phone. Mirae stores it masked and often without the 55; the CRM stores
  // E.164. The error is read: a database down is not "no contact".
  const phone = normalizePhoneBR(input.phone);
  if (!phone) return { outcome: "no_contact" };
  const variants = phoneLookupVariants(phone);
  const { data: contactRows, error: contactError } = await admin
    .from("contacts")
    .select("id, phone_number, is_personal, is_anonymized")
    .eq("organization_id", ctx.organizationId)
    .in("phone_number", variants)
    .is("is_merged_into", null)
    .limit(4);
  if (contactError) return { outcome: "unavailable", detail: contactError.message };
  const contact = escolherContatoCanonico(
    (contactRows ?? []) as Array<{
      id: string;
      phone_number: string | null;
      is_personal: boolean | null;
      is_anonymized: boolean | null;
    }>,
    phone,
  );
  if (!contact) return { outcome: "no_contact" };
  if (contact.is_personal || contact.is_anonymized) return { outcome: "contact_excluded" };

  // 3. The card: the contact's lead in that funnel.
  const { data: leadRows, error: leadError } = await admin
    .from("crm_leads")
    .select("id, organization_id, pipeline_id, stage_id, status, created_at, last_activity_at")
    .eq("organization_id", ctx.organizationId)
    .eq("contact_id", contact.id)
    .eq("pipeline_id", input.pipeline_id);
  if (leadError) return { outcome: "unavailable", detail: leadError.message };
  const picked = pickLead((leadRows ?? []) as LeadRow[], input.milestone);
  if ("outcome" in picked) return { outcome: picked.outcome };
  const lead = picked.lead;

  // 4. Move it, through the lead rule. Already there = nothing to write.
  let outcome: "moved" | "already_there" = "already_there";
  if (lead.stage_id !== stage.id) {
    try {
      await moveLeadHandler(
        admin,
        {
          organization_id: ctx.organizationId,
          actor: { type: "api_token", id: ctx.apiTokenId },
          requestId: ctx.requestId,
        },
        lead.id,
        { to_stage_id: stage.id, reason: TIMELINE_REASON[input.milestone] },
      );
      outcome = "moved";
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.status >= 500) return { outcome: "unavailable", leadId: lead.id, code: err.code };
      return {
        outcome:
          err.status === 409 && err.code === "lead_stage_changed_concurrent"
            ? "conflict"
            : "refused",
        leadId: lead.id,
        code: err.code,
        detail: err.message,
      };
    }
  }

  // 5. The agent's funnel follows, so its hint mirror does not undo the move.
  const harness = await advanceAgentFunnel(admin, {
    organizationId: ctx.organizationId,
    contactId: contact.id,
    step: input.milestone === "enrolled" ? "won" : "negotiating",
    reason: `mirae: ${input.milestone}`,
  });
  return { outcome, leadId: lead.id, harness };
}
