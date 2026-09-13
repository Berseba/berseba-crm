"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

/** Uma linha do resumo (contrato fixo do WP-A). */
export interface StageSuggestionSummaryRow {
  to_stage_id: string;
  to_stage_name: string;
  suggested: number;
  applied: number;
  rejected: number;
  /**
   * Fração 0–1 (`applied / (applied + rejected)`), conferida contra a rota
   * `leads/stage-suggestions/summary`. `null` quando ninguém decidiu nada ainda
   * — e isso NÃO é 0%: "nenhuma decisão" e "todas recusadas" são fatos
   * diferentes, e o painel mostra um traço no primeiro caso.
   */
  acceptance_rate: number | null;
}

/**
 * O resumo de aceitação das sugestões de etapa, por estágio — para a tela do
 * funil (`app/app/pipelines/[id]/_client.tsx`), item de medição mínima do
 * contrato. 28 dias por padrão, igual ao parâmetro que a rota já assume.
 */
export function useStageSuggestionsSummary(pipelineId: string | null, days = 28) {
  return useQuery({
    queryKey: ["stage-suggestions-summary", pipelineId, days] as const,
    queryFn: async () => {
      const res = await apiClient.get<{
        data: { days: number; by_stage: StageSuggestionSummaryRow[] };
      }>(`/api/v1/leads/stage-suggestions/summary?pipeline_id=${pipelineId}&days=${days}`);
      return (
        (res as { data?: { days?: number; by_stage?: StageSuggestionSummaryRow[] } }).data ?? null
      );
    },
    enabled: !!pipelineId,
  });
}
