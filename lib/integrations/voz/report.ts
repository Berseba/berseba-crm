/**
 * Berseba: the Bia's call report lands on the lead (Berseba/berseba issue #232, hook 3).
 *
 * Voz sends `call.ended` to `POST /api/v1/voz/call-ended` when a call's report is ready, and
 * retries on 401/403/408/409/429 and any 5xx (for 24 h). This file answers the same thing for the
 * same call:
 *
 *  - the card is the lead whose id Voz sends back (`lead_ref.id`, set by "Ligar com a Bia"); a call
 *    queued from Voz's own console has none, so the contact is found by phone and its open lead is
 *    the one `resolveActiveLeadForContact` picks, as everywhere else;
 *  - one report, one line: the line keeps Voz's `call_id` in `source_id`, and a second delivery of
 *    the same call finds it and writes nothing (`already_applied`);
 *  - in a Cold Call funnel the result moves the card by the Cold Call's own rule (`RESULTADOS`:
 *    the same stages, the same loss reasons, `moveLeadHandler` / `encerraDemanda`), and the line is
 *    a `cold_call_result`, so it counts as an attempt in the queue like a person's call. Anywhere
 *    else the card does not move: the line (`voz_call_report`) is for the team to decide;
 *  - a closed lead is never reopened by a call: only the line is written;
 *  - a business refusal (no contact, no lead, the lead rule said no) is a 200 with an outcome, so
 *    Voz stops retrying; a concurrent edit (409) and a database that did not answer (503) are
 *    worth a retry.
 *
 * Logs carry ids and outcomes only, never the phone nor the summary.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { moveLeadHandler } from "@/app/api/v1/leads/_handler";
import { ApiError } from "@/lib/api/types";
import { escolherContatoCanonico } from "@/lib/channels/contato-por-telefone";
import { normalizePhoneBR, phoneLookupVariants } from "@/lib/channels/phone-variants";
import {
  comMotivosDoColdCall,
  configDoFunil,
  RESULTADOS,
  type ResultadoDaLigacao,
} from "@/lib/cold-call/regras";
import { resolveActiveLeadForContact } from "@/lib/leads/active-lead";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { encerraDemanda } from "@/lib/leads/encerramento";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";

export const VOZ_OUTCOMES = [
  "meeting_booked",
  "interested",
  "callback",
  "not_interested",
  "no_answer",
  "opted_out",
  "wrong_number",
  "other",
] as const;
export type VozOutcome = (typeof VOZ_OUTCOMES)[number];

/** Voz's `call.ended` body. Unknown keys are dropped (Voz may add fields). */
export const vozCallEndedSchema = z.object({
  event: z.literal("call.ended").optional(),
  call_id: z.string().uuid(),
  to: z.string().trim().min(8).max(40),
  lead_ref: z
    .object({ id: z.string().trim().min(1).max(120) })
    .nullable()
    .optional(),
  status: z.string().max(40).optional(),
  outcome: z.enum(VOZ_OUTCOMES),
  summary: z.string().trim().min(1).max(4000),
  next_step: z.string().trim().max(500).nullable().optional(),
  action_plan: z.string().max(4000).nullable().optional(),
  duration_s: z.number().int().min(0).max(86_400).optional(),
});
export type VozCallEnded = z.infer<typeof vozCallEndedSchema>;

/** The Bia's conclusion → the Cold Call result. `null`: no move, only the line. */
export const RESULTADO_DA_BIA: Record<VozOutcome, ResultadoDaLigacao | null> = {
  meeting_booked: "reuniao",
  interested: "follow_up",
  callback: "follow_up",
  no_answer: "nao_atendeu",
  not_interested: "sem_interesse",
  opted_out: "sem_interesse",
  wrong_number: "numero_errado",
  other: null,
};

/** How the line names the Bia's conclusion (the team reads it on the card). */
export const ROTULO_DA_BIA: Record<VozOutcome, string> = {
  meeting_booked: "reunião marcada",
  interested: "interessado",
  callback: "pediu retorno",
  not_interested: "sem interesse",
  no_answer: "não atendeu",
  opted_out: "pediu para não receber ligações",
  wrong_number: "número errado",
  other: "ligação feita",
};

/** The timeline's one paragraph: who, what she concluded, the summary and the next step. */
export function textoDaLinha(input: VozCallEnded): string {
  const partes = [`Ligação da Bia (${ROTULO_DA_BIA[input.outcome]}): ${input.summary.trim()}`];
  if (input.next_step?.trim()) partes.push(`Próximo passo: ${input.next_step.trim()}`);
  const texto = partes.join(" ");
  return texto.length > 1500 ? `${texto.slice(0, 1499)}…` : texto;
}

export type ReportOutcome =
  /** The line is on the card, and the card moved (Cold Call) or did not need to. */
  | "applied"
  /** This call's line was already on the card: nothing written. */
  | "already_applied"
  /** No contact with this phone and no lead with this id. */
  | "no_contact"
  /** The contact has no open lead, or two tied. */
  | "no_lead"
  /** The lead rule refused the move; the line was written all the same. */
  | "refused"
  /** Someone changed the card at the same moment: retry. */
  | "conflict"
  /** The database did not answer: retry. */
  | "unavailable";

export interface ReportResult {
  outcome: ReportOutcome;
  leadId?: string;
  /** The Cold Call result applied, when the lead is in a Cold Call funnel. */
  resultado?: ResultadoDaLigacao | null;
  code?: string;
  detail?: string;
}

interface LeadRow {
  id: string;
  organization_id: string;
  pipeline_id: string;
  stage_id: string;
  contact_id: string | null;
  status: "open" | "won" | "lost";
  created_at: string;
  last_activity_at: string | null;
  crm_pipelines?: { settings: unknown } | null;
}

const LEAD_COLUMNS =
  "id, organization_id, pipeline_id, stage_id, contact_id, status, created_at, last_activity_at, crm_pipelines(settings)";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { organizationId: string; apiTokenId: string; requestId: string };

export async function applyVozReport(
  admin: SupabaseClient,
  ctx: Ctx,
  input: VozCallEnded,
): Promise<ReportResult> {
  const result = await apply(admin, ctx, input);
  const log = {
    organization_id: ctx.organizationId,
    request_id: ctx.requestId,
    call_id: input.call_id,
    voz_outcome: input.outcome,
    ...result,
  };
  if (result.outcome === "applied" || result.outcome === "already_applied") {
    logger.info("voz.call_report", log);
  } else {
    logger.warn("voz.call_report_not_applied", log);
  }
  return result;
}

/** The card this report belongs to, or why none. */
async function findLead(
  admin: SupabaseClient,
  ctx: Ctx,
  input: VozCallEnded,
): Promise<
  { lead: LeadRow } | { outcome: "no_contact" | "no_lead" | "unavailable"; detail?: string }
> {
  // 1. The lead the call was asked from. An id that is not a lead of this organization (or not a
  // uuid: calls queued before the button kept a contact id) falls back to the phone.
  const ref = input.lead_ref?.id;
  if (ref && UUID.test(ref)) {
    const { data, error } = await admin
      .from("crm_leads")
      .select(LEAD_COLUMNS)
      .eq("organization_id", ctx.organizationId)
      .eq("id", ref)
      .maybeSingle();
    if (error) return { outcome: "unavailable", detail: error.message };
    if (data) return { lead: data as unknown as LeadRow };
  }

  // 2. The contact, by phone (both spellings of the Brazilian 9th digit).
  const phone = normalizePhoneBR(input.to);
  if (!phone) return { outcome: "no_contact" };
  const { data: contactRows, error: contactError } = await admin
    .from("contacts")
    .select("id, phone_number, is_personal, is_anonymized")
    .eq("organization_id", ctx.organizationId)
    .in("phone_number", phoneLookupVariants(phone))
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
  if (!contact || contact.is_personal || contact.is_anonymized) return { outcome: "no_contact" };

  // 3. Its open lead, chosen like everywhere else.
  const { data: leadRows, error: leadError } = await admin
    .from("crm_leads")
    .select(LEAD_COLUMNS)
    .eq("organization_id", ctx.organizationId)
    .eq("contact_id", contact.id);
  if (leadError) return { outcome: "unavailable", detail: leadError.message };
  const leads = (leadRows ?? []) as unknown as LeadRow[];
  if (leads.length === 0) return { outcome: "no_lead" };
  const route = resolveActiveLeadForContact(leads);
  if (!route.routed) return { outcome: "no_lead" };
  return { lead: leads.find((l) => l.id === route.leadId)! };
}

/**
 * A lost result needs its reason listed in the funnel (`fn_validate_lost_reason_required`); a
 * Cold Call funnel created before the module listed them refuses every loss. Same fix as the Cold
 * Call result route, once.
 */
async function ensureColdCallReasons(
  admin: SupabaseClient,
  ctx: Ctx,
  lead: LeadRow,
): Promise<void> {
  const novos = comMotivosDoColdCall(lead.crm_pipelines?.settings);
  if (!novos) return;
  const { error } = await admin
    .from("crm_pipelines")
    .update({ settings: novos })
    .eq("id", lead.pipeline_id)
    .eq("organization_id", ctx.organizationId);
  if (error) throw new Error(error.message);
}

async function apply(admin: SupabaseClient, ctx: Ctx, input: VozCallEnded): Promise<ReportResult> {
  // One report, one line, across the whole organization: a retry must find the line wherever it was
  // written, even when the card it went to has since been closed and a lookup by phone would now
  // pick another card (review of #138).
  const { data: seen, error: seenError } = await admin
    .from("crm_lead_activities")
    .select("id, lead_id")
    .eq("organization_id", ctx.organizationId)
    .eq("source_module", "voz")
    .eq("source_id", input.call_id)
    .limit(1);
  if (seenError) return { outcome: "unavailable", detail: seenError.message };
  const already = (seen ?? [])[0] as { lead_id?: string } | undefined;
  if (already) return { outcome: "already_applied", leadId: already.lead_id };

  const found = await findLead(admin, ctx, input);
  if ("outcome" in found) return { outcome: found.outcome, detail: found.detail };
  const lead = found.lead;

  // The card moves only where the Cold Call module is on, by the Cold Call's own rule.
  const coldCall =
    configDoFunil(lead.crm_pipelines?.settings) !== null &&
    (await moduloLigado(admin, "cold_call"));
  const resultado = coldCall ? RESULTADO_DA_BIA[input.outcome] : null;
  const hctx = {
    organization_id: ctx.organizationId,
    actor: { type: "api_token" as const, id: ctx.apiTokenId },
    requestId: ctx.requestId,
  };

  // The line first: it is what makes a retry idempotent. A card moved before a failed line would,
  // on the retry, no longer be the contact's open lead (review of #138).
  const written = await emitLeadActivity(admin, {
    organizationId: ctx.organizationId,
    leadId: lead.id,
    contactId: lead.contact_id,
    type: coldCall ? "cold_call_result" : "voz_call_report",
    sourceModule: "voz",
    sourceId: input.call_id,
    actor: hctx.actor,
    reason: textoDaLinha(input),
    payload: {
      ...(resultado ? { resultado } : {}),
      voz_outcome: input.outcome,
      ...(input.duration_s !== undefined ? { duracao_s: input.duration_s } : {}),
    },
  });
  if (!written.ok) return { outcome: "unavailable", leadId: lead.id, detail: written.error };

  // Then the move. The line is written, so a failure here is reported, never retried: a retry would
  // find the line and stop.
  if (resultado && lead.status === "open") {
    const regra = RESULTADOS[resultado];
    try {
      if ("etapa" in regra) {
        const { data: etapa, error: etapaError } = await admin
          .from("crm_stages")
          .select("id")
          .eq("organization_id", ctx.organizationId)
          .eq("pipeline_id", lead.pipeline_id)
          .eq("slug", regra.etapa)
          .maybeSingle();
        if (etapaError) {
          return {
            outcome: "refused",
            leadId: lead.id,
            resultado,
            code: "stage_read_failed",
            detail: etapaError.message,
          };
        }
        if (!etapa)
          return {
            outcome: "refused",
            leadId: lead.id,
            resultado,
            code: "stage_missing",
            detail: regra.etapa,
          };
        if (etapa.id !== lead.stage_id) {
          await moveLeadHandler(admin, hctx, lead.id, {
            to_stage_id: etapa.id,
            reason: `Ligação da Bia: ${regra.rotulo}`,
          });
        }
      } else {
        await ensureColdCallReasons(admin, ctx, lead);
        await encerraDemanda(admin, hctx, {
          leadId: lead.id,
          desfecho: "lost",
          motivo: regra.rotulo,
        });
      }
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "move_failed";
      const detail = err instanceof Error ? err.message : String(err);
      return { outcome: "refused", leadId: lead.id, resultado, code, detail };
    }
  }
  return { outcome: "applied", leadId: lead.id, resultado };
}
