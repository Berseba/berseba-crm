/**
 * GET /api/v1/leads/stage-suggestions/summary?pipeline_id=&days=28
 *
 * A MEDIÇÃO que decide promover uma etapa de "sugere" (nível 2) para
 * "automático" (nível 1) — ver o cabeçalho de
 * `lib/organizacoes/ai-stage-moves.ts`. Promoção é ato de QUEM administra,
 * lendo este número; esta rota não decide nada sozinha.
 *
 * `days` (padrão 28) é a janela de `created_at`; `pipeline_id` filtra pelo
 * pipeline do NEGÓCIO da sugestão (via `crm_leads.pipeline_id`), porque a
 * sugestão em si não guarda `pipeline_id` (DIRC — já dá para chegar lá por
 * `lead_id`). Agregação em memória: o volume de sugestões por org é pequeno
 * o bastante para não justificar uma function `security definer` só para
 * somar linhas — se isso mudar, RPC entra aqui sem mudar o contrato da rota.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  pipeline_id: z.string().uuid().optional(),
  days: z.coerce.number().int().min(1).max(365).default(28),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_stage_move_suggestions" });
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    pipeline_id: url.searchParams.get("pipeline_id") ?? undefined,
    days: url.searchParams.get("days") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", "pipeline_id (uuid) e days (1-365) inválidos.", 422, {
      requestId,
    });
  }
  const { pipeline_id: pipelineId, days } = parsed.data;

  const supabase = await createClient();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  let query = supabase
    .from("crm_stage_move_suggestions")
    .select("to_stage_id, status, crm_leads!inner(pipeline_id)")
    .gte("created_at", since);
  if (pipelineId) query = query.eq("crm_leads.pipeline_id", pipelineId);

  const { data: rows, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  type Row = { to_stage_id: string; status: string };
  const suggestions = (rows ?? []) as unknown as Row[];

  const porEtapa = new Map<string, { suggested: number; applied: number; rejected: number }>();
  for (const s of suggestions) {
    const acc = porEtapa.get(s.to_stage_id) ?? { suggested: 0, applied: 0, rejected: 0 };
    acc.suggested += 1;
    if (s.status === "applied") acc.applied += 1;
    if (s.status === "rejected") acc.rejected += 1;
    porEtapa.set(s.to_stage_id, acc);
  }

  const stageIds = [...porEtapa.keys()];
  const stageNames = new Map<string, string>();
  if (stageIds.length > 0) {
    const { data: stages, error: stagesErr } = await supabase
      .from("crm_stages")
      .select("id, name")
      .in("id", stageIds);
    if (stagesErr) return fail("internal_error", stagesErr.message, 500, { requestId });
    for (const s of stages ?? []) stageNames.set(s.id as string, s.name as string);
  }

  const byStage = stageIds.map((toStageId) => {
    const c = porEtapa.get(toStageId)!;
    const decididas = c.applied + c.rejected;
    return {
      to_stage_id: toStageId,
      to_stage_name: stageNames.get(toStageId) ?? null,
      suggested: c.suggested,
      applied: c.applied,
      rejected: c.rejected,
      // null (não 0) quando ninguém decidiu ainda — 0% mentiria "recusada
      // sempre" quando na verdade é "sem decisão o bastante para medir".
      acceptance_rate: decididas > 0 ? c.applied / decididas : null,
    };
  });

  return ok({ days, by_stage: byStage }, { requestId });
}
