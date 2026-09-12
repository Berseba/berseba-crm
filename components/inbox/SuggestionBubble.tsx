"use client";
import { useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Robot } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useDecideReplyDraft, useReplyDraft } from "@/hooks/inbox/useReplyDraft";

interface Props {
  conversationId: string;
  /** Leva o foco ao campo de edição do rascunho, no `ReplyReviewPanel`/composer. */
  onEditar?: () => void;
}

/**
 * Bolha no fim do fio para o rascunho `pending`/`generating` que o motor
 * gravou em `ai_reply_drafts` (agente em modo assistido) e ainda não enviou.
 *
 * Antes só existia no `ReplyReviewPanel` (painel acima do composer) — quem lê
 * a conversa não via a sugestão no lugar onde ela faz sentido: no fim do fio,
 * como uma bolha. Reaproveita o MESMO polling (`useReplyDraft`, ver o
 * comentário sobre queryKey compartilhada) e as MESMAS ações
 * (`useDecideReplyDraft` → `fn_reply_action`, a rota existente).
 *
 * Visualmente distinta de mensagem enviada de propósito: borda tracejada,
 * fundo neutro, sem tick de entrega — para nunca ser confundida com algo que
 * já saiu para o cliente.
 */
export function SuggestionBubble({ conversationId, onEditar }: Props) {
  const t = useT();
  const { draft } = useReplyDraft(conversationId);
  const decide = useDecideReplyDraft(conversationId);
  // Some da tela assim que o atendente decide, sem esperar o próximo poll (até
  // 4s) ou a invalidação da mutation — a transição fica instantânea e sem
  // flicker. Comparado por draft.id (não um boolean solto): uma sugestão NOVA
  // (id diferente, ex.: o atendente gerou outra) reabre a bolha sozinha,
  // porque o id novo nunca bate com o que foi ocultado aqui.
  const [ocultaDoId, setOcultaDoId] = useState<string | null>(null);

  if (!draft || draft.id === ocultaDoId) return null;
  if (draft.status !== "pending" && draft.status !== "generating") return null;

  const body = draft.edited_body ?? draft.original_body ?? "";
  const gerando = draft.status === "generating";

  async function decidir(action: "approve" | "reject") {
    setOcultaDoId(draft!.id);
    try {
      await decide.mutateAsync({
        draftId: draft!.id,
        revision: draft!.revision,
        action,
        body,
      });
    } catch (e) {
      // Falhou: a bolha volta, o atendente tenta de novo — a edição/decisão
      // não se perde silenciosamente.
      showApiError(e);
      setOcultaDoId(null);
    }
  }

  return (
    <div className="group flex w-full items-center gap-1 px-4 py-1 justify-end" data-testid="suggestion-bubble">
      <div
        role="status"
        className={cn(
          "max-w-[75%] rounded-2xl rounded-br-sm border border-dashed border-muted-foreground/50",
          "bg-muted/40 px-3 py-2 text-sm text-foreground shadow-none",
        )}
      >
        <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-muted-foreground">
          <Robot size={12} weight="duotone" aria-hidden />
          {t("Sugestão da IA — não enviada")}
        </div>

        {gerando ? (
          <div className="space-y-1.5 py-0.5">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-28" />
            <p className="pt-0.5 text-xs text-muted-foreground">{t("Gerando sugestão…")}</p>
          </div>
        ) : (
          <>
            <p className="whitespace-pre-wrap break-words leading-snug">{body}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                aria-label={t("Aprovar e enviar")}
                disabled={decide.isPending || !body.trim()}
                onClick={() => decidir("approve")}
              >
                {t("Aprovar e enviar")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={t("Editar")}
                disabled={decide.isPending}
                onClick={onEditar}
              >
                {t("Editar")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t("Rejeitar")}
                disabled={decide.isPending}
                onClick={() => decidir("reject")}
              >
                {t("Rejeitar")}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
