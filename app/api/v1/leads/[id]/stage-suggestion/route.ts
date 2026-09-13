/**
 * GET /api/v1/leads/[id]/stage-suggestion
 *
 * A sugestão PENDENTE deste negócio, ou `null` — é o que o chip/tela do
 * negócio consulta para decidir se mostra "o assistente sugeriu mover para X"
 * (ver `.changes/sugestao-de-etapa.md`). Índice único parcial garante no banco
 * que nunca há mais de uma pendente por `lead_id`; `.maybeSingle()` aqui é só
 * o espelho dessa garantia no transporte.
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
  const { id: leadId } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "crm_stage_move_suggestions" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();

  const { data: row, error } = await supabase
    .from("crm_stage_move_suggestions")
    .select("id, lead_id, from_stage_id, to_stage_id, reason, source, created_at")
    .eq("lead_id", leadId)
    .eq("status", "pending")
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  if (!row) return ok({ suggestion: null }, { requestId });

  const { data: stage, error: stageErr } = await supabase
    .from("crm_stages")
    .select("name")
    .eq("id", row.to_stage_id)
    .maybeSingle();
  if (stageErr) return fail("internal_error", stageErr.message, 500, { requestId });

  return ok(
    {
      suggestion: {
        id: row.id,
        lead_id: row.lead_id,
        from_stage_id: row.from_stage_id,
        to_stage_id: row.to_stage_id,
        to_stage_name: stage?.name ?? null,
        reason: row.reason,
        source: row.source,
        created_at: row.created_at,
      },
    },
    { requestId },
  );
}
