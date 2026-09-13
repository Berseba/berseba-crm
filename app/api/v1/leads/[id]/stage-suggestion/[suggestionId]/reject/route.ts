/**
 * POST /api/v1/leads/[id]/stage-suggestion/[suggestionId]/reject
 *
 * O humano DISCORDA da sugestão da IA. O card não é tocado — a recusa é sinal,
 * não ausência de sinal (mesma régua de `consent_declined`/`lead_disqualified`
 * em `lib/leads/activity-vocabulary.ts`): o payload da atividade
 * (`etapa_da_ia`, `etapa_do_humano`, `agent_id`, `pipeline_id`) é o MESMO shape
 * de `agent_move_corrected` porque é o mesmo sinal do laço de aprendizado
 * (spec 17 passo 5) — só que capturado ANTES de o card andar, em vez de
 * inferido depois por comparação de histórico.
 *
 * Mesma alçada de mover card (`requireRole("agent")`).
 *
 * ⚠️ `crm_stage_move_suggestions` só concede `SELECT` a `authenticated`
 * (migration 0239, igual `ai_reply_drafts`) — decidir é mutação de
 * `service_role`. Leitura/escrita DESTA tabela usa o client admin, com
 * `organization_id` de fonte confiável (`requireRole`) filtrado manualmente
 * em toda query — a regra do CLAUDE.md para handler com admin client.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
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
    .select("id, lead_id, from_stage_id, to_stage_id, agent_id, status")
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
    .select("id, contact_id, pipeline_id")
    .eq("id", leadId)
    .maybeSingle();
  if (leadErr) return fail("internal_error", leadErr.message, 500, { requestId });
  if (!lead) return fail("not_found", t("Lead não encontrado."), 404, { requestId });

  const decidedAt = new Date().toISOString();
  const { error: updErr } = await admin
    .from("crm_stage_move_suggestions")
    .update({ status: "rejected", decided_by: user.id, decided_at: decidedAt })
    .eq("organization_id", org.orgId)
    .eq("id", suggestionId)
    .eq("status", "pending");
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  const atividade = await emitLeadActivity(supabase, {
    organizationId: org.orgId,
    leadId,
    contactId: (lead as { contact_id: string | null }).contact_id,
    type: "stage_move_suggestion_rejected",
    sourceModule: "crm",
    sourceId: leadId,
    actor: { type: "user", id: user.id },
    reason: "Uma pessoa recusou a sugestão de etapa do assistente",
    payload: {
      etapa_da_ia: suggestion.to_stage_id,
      etapa_do_humano: suggestion.from_stage_id,
      agent_id: suggestion.agent_id,
      pipeline_id: lead.pipeline_id,
    },
  });
  if (!atividade.ok) {
    await registraFalhaDeAtividade(supabase, {
      organizationId: org.orgId,
      leadId,
      tipo: "stage_move_suggestion_rejected",
      origem: "leads/[id]/stage-suggestion/[suggestionId]/reject",
      erro: atividade.error,
      requestId,
    });
  }

  await audit({
    action: "crm.stage_suggestion_rejected",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "crm_stage_move_suggestion",
    resourceId: suggestionId,
    requestId,
    metadata: { lead_id: leadId, from_stage_id: suggestion.from_stage_id, to_stage_id: suggestion.to_stage_id },
  });

  return ok({ suggestion_id: suggestionId, status: "rejected" }, { requestId });
}
