"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export type ReplyDraft = {
  id: string;
  revision: string;
  status: string;
  original_body: string | null;
  edited_body: string | null;
  error_code: string | null;
  proposals: Array<{ tool: string; arguments: unknown }>;
};

export type ReplyDraftDecision = "approve" | "reject";

/**
 * Estado do interruptor de sombra que a rota `draft-reply` devolve junto com
 * os rascunhos (`lib/ai/modo-sombra/`): a IA sugere e nunca envia quando a
 * organização ou o canal ligou o modo. Vem no mesmo GET para não abrir um
 * segundo polling.
 */
export type ModoSombra = { ligado: boolean; origem: "organizacao" | "canal" | null };

/**
 * Chave compartilhada do polling de rascunho de resposta.
 *
 * `ReplyReviewPanel` (painel do composer) e `SuggestionBubble` (bolha no fim
 * do fio, `ChatThread`) leem o MESMO rascunho — usar a mesma queryKey faz o
 * React Query tratar as duas montagens como uma única query em cache, em vez
 * de dois pollings independentes de 4s cada um.
 */
export function chaveDoRascunho(conversationId: string) {
  return ["reply-drafts", conversationId] as const;
}

/**
 * Onda 5.x: leitura do rascunho `ai_reply_drafts` pendente de revisão de uma
 * conversa (o motor grava e não envia quando o agente está em modo assistido).
 * `null` de `conversationId` desliga o polling — nenhuma conversa selecionada.
 */
export function useReplyDraft(conversationId: string | null) {
  const query = useQuery({
    queryKey: chaveDoRascunho(conversationId ?? ""),
    queryFn: () =>
      apiClient.get<{ data: { drafts: ReplyDraft[]; modo_sombra?: ModoSombra } }>(
        `/api/v1/conversations/${conversationId}/draft-reply`,
      ),
    enabled: !!conversationId,
    refetchInterval: 4000,
    retry: false,
  });
  // Opcional em cada nível: um proxy/sessão expirada que devolva algo fora do
  // envelope combinado (`{ data: [] }`, corpo vazio…) não pode virar exceção
  // de render — mesmo cuidado de `useEtapasDeGatilho` com resposta fora do
  // contrato.
  return {
    ...query,
    draft: query.data?.data?.drafts?.[0],
    modoSombra: query.data?.data?.modo_sombra,
  };
}

/**
 * Aprova ou rejeita o rascunho — mesma rota que o `ReplyReviewPanel` sempre
 * disparou (`fn_reply_action` via `POST /api/v1/ai/replies/[id]`). Nenhuma
 * rota nova: só o consumidor mudou (agora também a bolha do fio).
 */
export function useDecideReplyDraft(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      draftId: string;
      revision: string;
      action: ReplyDraftDecision;
      body?: string;
      feedback?: string;
    }) =>
      apiClient.post(`/api/v1/ai/replies/${vars.draftId}`, {
        action: vars.action,
        revision: vars.revision,
        body: vars.body,
        feedback: vars.feedback,
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: chaveDoRascunho(conversationId) }),
  });
}
