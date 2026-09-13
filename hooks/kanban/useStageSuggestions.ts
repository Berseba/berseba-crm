"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { marcarEcoLocal, liberarEcoLocal } from "@/lib/kanban/local-echo";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";

/** O shape que a rota `stage-suggestions` devolve (contrato fixo do WP-A). */
export interface StageSuggestionLive {
  id: string;
  lead_id: string;
  from_stage_id: string;
  to_stage_id: string;
  to_stage_name: string;
  reason: string | null;
  source: string;
  created_at: string;
}

function chaveDeSugestoes(pipelineId: string) {
  return ["stage-suggestions", pipelineId] as const;
}

/**
 * As sugestões de movimento de etapa PENDENTES do pipeline, para o board.
 *
 * UMA busca por pipeline, não um polling por card: o `KanbanBoard` monta o
 * Map lead→sugestão (como já faz com `reactivations`) e cada `KanbanCard`
 * recebe só a fatia dele.
 *
 * Polling de 5s — mais curto que o de retomada (`useReactivations`, 60s) de
 * propósito: a sugestão nasce no meio de uma conversa em andamento agora, não
 * de um cron. O board já segue esse mesmo ritmo em outro lugar (o composer do
 * inbox pola o rascunho da IA a cada 4s via `useReplyDraft`) — 5s é a mesma
 * ordem de grandeza para o mesmo tipo de evento: proposta da IA que só existe
 * enquanto ninguém decidiu.
 *
 * Além do polling, ouve o MESMO canal de `crm_leads` que `useBoard` já
 * assina para este pipeline. Não é o MESMO canal (cada hook tem a própria
 * instância — `useRealtimeChannel` sufixa por hook, então não há conflito de
 * assinatura), mas escuta a MESMA tabela: mover ou decidir uma sugestão
 * sempre passa por uma escrita em `crm_leads` (a sugestão referencia o lead),
 * e reagir ao evento fecha a janela de até 5s do polling em vez de esperá-la.
 */
export function useStageSuggestions(pipelineId: string | null) {
  const qc = useQueryClient();
  const queryKey = chaveDeSugestoes(pipelineId ?? "");

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await apiClient.get<{ data: { suggestions: StageSuggestionLive[] } }>(
        `/api/v1/pipelines/${pipelineId}/stage-suggestions`,
      );
      return (res as { data?: { suggestions?: StageSuggestionLive[] } }).data?.suggestions ?? [];
    },
    enabled: !!pipelineId,
    refetchInterval: 5_000,
  });

  useRealtimeChannel({
    name: pipelineId ? `stage-suggestions-${pipelineId}` : "stage-suggestions-disabled",
    postgresChanges: pipelineId
      ? {
          event: "*",
          schema: "public",
          table: "crm_leads",
          filter: `pipeline_id=eq.${pipelineId}`,
        }
      : undefined,
    onChange: () => qc.invalidateQueries({ queryKey }),
    enabled: !!pipelineId,
  });

  return query;
}

interface DecidirArgs {
  leadId: string;
  suggestionId: string;
  decision: "apply" | "reject";
}

/**
 * A decisão humana sobre a sugestão de movimento de etapa — chip do card e do
 * dossiê chamam a MESMA mutação.
 *
 * `apply` MOVE o lead (novo `stage_id`): eco local como `useDecidirProximaAcao`,
 * senão o card pulsa na cara de quem acabou de clicar. `reject` só decide a
 * linha da sugestão sem tocar o lead — eco aqui ficaria pendurado esperando um
 * evento que nunca vem (mesmo raciocínio de `useDecidirReativacao`).
 */
export function useDecidirSugestaoDeEtapa(pipelineId: string) {
  const qc = useQueryClient();
  const boardKey = ["board", pipelineId] as const;
  const suggestionsKey = chaveDeSugestoes(pipelineId);

  return useMutation({
    mutationFn: async ({ leadId, suggestionId, decision }: DecidirArgs) => {
      if (decision === "apply") marcarEcoLocal(leadId);
      return apiClient.post<{ data: unknown }>(
        `/api/v1/leads/${leadId}/stage-suggestion/${suggestionId}/${decision}`,
        {},
      );
    },
    onError: (err) => {
      // 409 `stage_suggestion_not_pending`: outra pessoa decidiu entre o
      // render e o clique. Recarregar é o que faz o card mostrar o estado
      // real em vez de continuar oferecendo um botão para algo já resolvido.
      if (err instanceof ApiError && err.status === 409) {
        qc.invalidateQueries({ queryKey: suggestionsKey });
        qc.invalidateQueries({ queryKey: boardKey });
      }
      showApiError(err);
    },
    onSettled: (_data, _err, args) => {
      if (args.decision === "apply") liberarEcoLocal(args.leadId);
      qc.invalidateQueries({ queryKey: suggestionsKey });
      qc.invalidateQueries({ queryKey: boardKey });
      qc.invalidateQueries({ queryKey: ["lead-stage-suggestion", args.leadId] });
    },
  });
}
