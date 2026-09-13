"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { StageSuggestionLive } from "@/hooks/kanban/useStageSuggestions";

/**
 * A sugestão de movimento de etapa pendente DESTE negócio, para o dossiê.
 *
 * Mesmo shape da API do board (`stage-suggestions`), resolvida no servidor
 * para UM lead: o dossiê não filtra a lista do pipeline inteiro, porque abrir
 * o dossiê de um card sem sugestão não deveria custar buscar a lista
 * inteira do funil.
 *
 * Mesmo ritmo de `useStageSuggestions` (5s) — o dossiê fica aberto enquanto a
 * pessoa lê a timeline, e é justamente aí que uma sugestão pode nascer.
 */
export function useLeadStageSuggestion(leadId: string | null) {
  return useQuery({
    queryKey: ["lead-stage-suggestion", leadId] as const,
    queryFn: async () => {
      const res = await apiClient.get<{ data: { suggestion: StageSuggestionLive | null } }>(
        `/api/v1/leads/${leadId}/stage-suggestion`,
      );
      return (res as { data?: { suggestion?: StageSuggestionLive | null } }).data?.suggestion ?? null;
    },
    enabled: !!leadId,
    refetchInterval: 5_000,
  });
}
