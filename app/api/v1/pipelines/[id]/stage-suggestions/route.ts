/**
 * GET /api/v1/pipelines/[id]/stage-suggestions
 *
 * Lista as sugestões de etapa PENDENTES do pipeline — o modelo de três níveis
 * de confiança (`lib/leads/stage-move-policy.ts`) em que a IA sugere e o
 * humano confirma. Gravadas por `sincronizaEstagioDoAgente`
 * (`lib/leads/agent-stage-sync.ts`) quando o knob
 * `organizations.settings.crm.ai_stage_moves` está em `"suggest"`, ou sempre
 * que o destino fecha o negócio.
 *
 * Mesma alçada de mover card (`requireRole("agent")` — spec 13 §4, escrita é
 * agent+, viewer é read-only), RLS escopa por organização via
 * `fn_user_org_ids()`. O filtro por pipeline é feito pelo embed
 * `crm_leads!inner(pipeline_id)`: a sugestão não guarda `pipeline_id` próprio
 * (DIRC — a informação já existe via `lead_id` → `crm_leads.pipeline_id`,
 * duplicá-la aqui seria a mesma dado em dois lugares para divergir depois).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: pipelineId } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "crm_stage_move_suggestions" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();

  const { data: rows, error } = await supabase
    .from("crm_stage_move_suggestions")
    .select("id, lead_id, from_stage_id, to_stage_id, reason, source, created_at, crm_leads!inner(pipeline_id)")
    .eq("status", "pending")
    .eq("crm_leads.pipeline_id", pipelineId)
    .order("created_at", { ascending: false });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  type Row = {
    id: string;
    lead_id: string;
    from_stage_id: string;
    to_stage_id: string;
    reason: string | null;
    source: string;
    created_at: string;
  };
  const suggestions = (rows ?? []) as unknown as Row[];

  const toStageIds = [...new Set(suggestions.map((s) => s.to_stage_id))];
  const stageNames = new Map<string, string>();
  if (toStageIds.length > 0) {
    const { data: stages, error: stagesErr } = await supabase
      .from("crm_stages")
      .select("id, name")
      .in("id", toStageIds);
    if (stagesErr) return fail("internal_error", stagesErr.message, 500, { requestId });
    for (const s of stages ?? []) stageNames.set(s.id as string, s.name as string);
  }

  return ok(
    {
      suggestions: suggestions.map((s) => ({
        id: s.id,
        lead_id: s.lead_id,
        from_stage_id: s.from_stage_id,
        to_stage_id: s.to_stage_id,
        to_stage_name: stageNames.get(s.to_stage_id) ?? null,
        reason: s.reason,
        source: s.source,
        created_at: s.created_at,
      })),
    },
    { requestId },
  );
}
