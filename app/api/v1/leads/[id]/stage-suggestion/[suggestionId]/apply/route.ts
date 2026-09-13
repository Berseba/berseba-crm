/**
 * POST /api/v1/leads/[id]/stage-suggestion/[suggestionId]/apply
 *
 * O humano CONFIRMA a sugestão da IA (nível 2/3 do modelo de confiança). Move
 * o card pelo MESMO código do caminho humano de mover — `moveLeadHandler`
 * (`app/api/v1/leads/_handler.ts`), já extraído e reusado pelo MCP
 * (`crm_move_lead_stage`) e pela rota `bulk`. Não duplica a lógica de
 * concorrência (Pattern B/OCC) nem o trigger de status
 * (`fn_crm_lead_close_on_stage`) — os dois vivem só ali.
 *
 * Mesma alçada de mover card (`requireRole("agent")`).
 *
 * ⚠️ `crm_stage_move_suggestions` só concede `SELECT` a `authenticated`
 * (migration 0239, igual `ai_reply_drafts`) — decidir (`applied`/`rejected`)
 * é mutação de `service_role`. Por isso a leitura/escrita DESTA tabela usa o
 * client admin, com `organization_id` de fonte confiável (`requireRole`,
 * nunca do body/path) filtrado manualmente em toda query — a regra do
 * CLAUDE.md para handler com admin client. O card em si (`crm_leads`)
 * continua pelo client de sessão dentro de `moveLeadHandler`, que já é RLS.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import { moveLeadHandler } from "@/app/api/v1/leads/_handler";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string; suggestionId: string }>;
}

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId, suggestionId } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "crm_stage_move_suggestions" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);

  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: suggestion, error: selErr } = await admin
    .from("crm_stage_move_suggestions")
    .select("id, lead_id, from_stage_id, to_stage_id, status")
    .eq("organization_id", org.orgId)
    .eq("id", suggestionId)
    .eq("lead_id", leadId)
    .maybeSingle();
  if (selErr) return fail("internal_error", selErr.message, 500, { requestId });
  if (!suggestion) {
    return fail("not_found", t("Sugestão não encontrada."), 404, { requestId });
  }
  if (suggestion.status !== "pending") {
    return fail(
      "stage_suggestion_not_pending",
      t("Esta sugestão já foi decidida."),
      409,
      { requestId, details: { status: suggestion.status } },
    );
  }

  const { data: lead, error: leadErr } = await supabase
    .from("crm_leads")
    .select("id, stage_id, contact_id, pipeline_id, organization_id")
    .eq("id", leadId)
    .maybeSingle();
  if (leadErr) return fail("internal_error", leadErr.message, 500, { requestId });
  if (!lead) return fail("not_found", t("Lead não encontrado."), 404, { requestId });

  let detail = `Movido para o estágio sugerido pelo assistente.`;
  if (lead.stage_id === suggestion.to_stage_id) {
    // O negócio já está lá (um humano pode ter movido no meio do caminho, ou a
    // sugestão é de um turno anterior à mudança). Marcar `applied` SEM mover é
    // honesto: não há transição para o `moveLeadHandler` registrar de novo.
    detail = t("O negócio já estava na etapa sugerida — nada foi movido.");
  } else {
    try {
      await moveLeadHandler(
        supabase,
        { organization_id: org.orgId, actor: { type: "user", id: user.id }, requestId, idioma: user.idioma },
        leadId,
        {
          to_stage_id: suggestion.to_stage_id,
          reason: "Sugestão do assistente aplicada pelo humano",
        },
      );
    } catch (err) {
      if (err instanceof ApiError) {
        return fail(err.code, err.message, err.status, {
          details: err.details,
          requestId,
        });
      }
      throw err;
    }
  }

  const decidedAt = new Date().toISOString();
  const { error: updErr } = await admin
    .from("crm_stage_move_suggestions")
    .update({ status: "applied", decided_by: user.id, decided_at: decidedAt })
    .eq("organization_id", org.orgId)
    .eq("id", suggestionId)
    .eq("status", "pending");
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  const atividade = await emitLeadActivity(supabase, {
    organizationId: org.orgId,
    leadId,
    contactId: (lead as { contact_id: string | null }).contact_id,
    type: "stage_move_suggestion_applied",
    sourceModule: "crm",
    sourceId: leadId,
    actor: { type: "user", id: user.id },
    reason: detail,
    payload: { suggestion_id: suggestionId, from_stage_id: suggestion.from_stage_id, to_stage_id: suggestion.to_stage_id },
  });
  if (!atividade.ok) {
    await registraFalhaDeAtividade(supabase, {
      organizationId: org.orgId,
      leadId,
      tipo: "stage_move_suggestion_applied",
      origem: "leads/[id]/stage-suggestion/[suggestionId]/apply",
      erro: atividade.error,
      requestId,
    });
  }

  await audit({
    action: "crm.stage_suggestion_applied",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "crm_stage_move_suggestion",
    resourceId: suggestionId,
    requestId,
    metadata: { lead_id: leadId, from_stage_id: suggestion.from_stage_id, to_stage_id: suggestion.to_stage_id },
  });

  return ok({ suggestion_id: suggestionId, status: "applied", detail }, { requestId });
}
