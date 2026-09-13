"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

export type AiStageMovesMode = "auto" | "suggest";

const QUERY_KEY = ["ai-stage-moves"] as const;

/**
 * O knob "movimentação de etapa pela IA" (WP-A): `auto` move o negócio
 * sozinho conforme a conversa avança; `suggest` grava uma proposta pendente
 * para um humano aplicar ou recusar no funil. Ganhou e perdeu são SEMPRE
 * sugeridos, em qualquer modo — a tela só relata o padrão dos demais destinos.
 *
 * ⚠️ Ao contrário de modo-sombra/nicho (lidos direto do banco em
 * `app/app/settings/security/page.tsx`, Server Component), este valor é
 * buscado no CLIENTE. Motivo: este pacote não conhece a coluna/chave do jsonb
 * onde o WP-A grava o modo — o contrato fixo que esta tarefa recebeu é só o
 * endpoint. Ler aqui, contra a rota, evita duplicar um formato de leitura que
 * poderia divergir da fonte (a mesma doença que a doutrina DIRC do repo
 * chama de "Duplicar — vive aqui mesmo?"). Custo: a tela nasce sem o valor
 * (loading) em vez de já vir pintada pelo SSR — aceitável para um painel de
 * configuração raramente aberto.
 */
export function useAiStageMoves() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const res = await apiClient.get<{ data: { mode: AiStageMovesMode } }>(
        "/api/v1/settings/ai-stage-moves",
      );
      return (res as { data?: { mode?: AiStageMovesMode } }).data?.mode ?? "auto";
    },
  });
}

/** Salva o modo — mesma rota, `PATCH`, admin apenas (o backend barra o resto). */
export function useSalvarAiStageMoves() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: AiStageMovesMode) =>
      apiClient.patch("/api/v1/settings/ai-stage-moves", { mode }),
    onError: showApiError,
    onSettled: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}
