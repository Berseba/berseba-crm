"use client";
import type { MouseEvent } from "react";

import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import { Sparkle } from "@/lib/ui/icons";
import { useDecidirSugestaoDeEtapa } from "@/hooks/kanban/useStageSuggestions";

interface StageSuggestionChipProps {
  leadId: string;
  suggestionId: string;
  toStageName: string;
  pipelineId: string;
}

/**
 * O chip da sugestão de movimento de etapa — mesma peça no card do Kanban
 * (faixa ③, dentro do slot fixo) e no dossiê (cabeçalho vivo), porque as duas
 * telas fazem a mesma pergunta: aplicar ou recusar o que a IA sugeriu.
 *
 * `w-full` de propósito: no card ele é o ÚNICO conteúdo da faixa de altura
 * fixa (§5 do contrato de UI — nunca cresce o card), então precisa preencher
 * a linha para o texto truncar contra os botões fixos, do mesmo jeito que
 * `NextActionSlot`/`ReactivationSlot` já fazem. No dossiê, onde o cabeçalho
 * tem vários badges na mesma linha (`flex flex-wrap`), `w-full` empurra o
 * chip para a própria linha — correto aqui: é a única peça do cabeçalho que
 * pede uma decisão, e ela não devia disputar espaço com informação passiva.
 *
 * Cor: a MESMA família de "Sugestão da IA — não enviada" do inbox
 * (`components/inbox/SuggestionBubble.tsx`) — texto e ícone em `text-muted`,
 * nunca a cor de destaque que `NextActionSlot` usa para "há uma ação aprovada
 * esperando envio". É um conceito diferente (a IA propôs; ninguém confirmou
 * nada ainda) e o produto já tem uma cor para ele — reusar em vez de inventar
 * uma terceira variação de "proposta da IA" na mesma tela.
 */
export function StageSuggestionChip({
  leadId,
  suggestionId,
  toStageName,
  pipelineId,
}: StageSuggestionChipProps) {
  const t = useT();
  const decidir = useDecidirSugestaoDeEtapa(pipelineId);

  const decide = (e: MouseEvent<HTMLButtonElement>, decision: "apply" | "reject") => {
    // No card, o wrapper inteiro seleciona/abre ao clique; decidir não é nem
    // uma coisa nem outra. No dossiê não há esse conflito, mas a chamada é
    // inofensiva de qualquer jeito.
    e.stopPropagation();
    decidir.mutate({ leadId, suggestionId, decision });
  };

  return (
    <span className="flex w-full min-w-0 items-center gap-1.5 text-xs">
      <Sparkle size={12} weight="duotone" className="shrink-0 text-text-muted" aria-hidden />
      <span
        className="min-w-0 flex-1 truncate text-text-muted"
        title={`${t("IA sugere:")} ${toStageName}`}
      >
        {t("IA sugere:")} {toStageName}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          disabled={decidir.isPending}
          onClick={(e) => decide(e, "apply")}
          // O rótulo curto cabe no chip; o acessível diz PARA ONDE — "Aplicar"
          // sozinho, lido fora de contexto, não diz o que vai mudar.
          aria-label={`${t("Aplicar sugestão:")} ${toStageName}`}
          className={cn(
            "rounded-md px-1.5 py-0.5 text-[11px] font-medium transition-colors",
            "bg-text/10 text-text hover:bg-text/20",
            "disabled:opacity-50",
          )}
        >
          {t("Aplicar")}
        </button>
        <button
          type="button"
          disabled={decidir.isPending}
          onClick={(e) => decide(e, "reject")}
          aria-label={`${t("Recusar sugestão:")} ${toStageName}`}
          className={cn(
            "rounded-md px-1.5 py-0.5 text-[11px] transition-colors",
            "text-text-muted hover:bg-surface-muted hover:text-text",
            "disabled:opacity-50",
          )}
        >
          {t("Recusar")}
        </button>
      </span>
    </span>
  );
}
