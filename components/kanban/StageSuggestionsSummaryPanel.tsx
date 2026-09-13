"use client";
import { useT } from "@/hooks/i18n/useT";
import { useStageSuggestionsSummary } from "@/hooks/kanban/useStageSuggestionsSummary";

/**
 * Medição mínima do contrato (item 4): "Sugestões: N · aceitas X% (28 dias)"
 * por etapa, na tela do funil — que é a única tela com `pipelineId` em mãos
 * (a `/app/metrics` global agrega TODOS os pipelines por atendente, sem
 * parâmetro `pipeline_id`; encaixar o resumo lá misturaria etapas de funis
 * diferentes com o mesmo `stage_id` só existindo dentro de um pipeline).
 *
 * Silêncio quando não há nenhuma etapa com sugestão no período — "ninguém
 * sugeriu nada ainda" é estado normal, não teria o que dizer que outra faixa
 * do produto (ex. `ConversaSlot`) já não trate como ausência normal.
 */
export function StageSuggestionsSummaryPanel({ pipelineId }: { pipelineId: string }) {
  const t = useT();
  const { data } = useStageSuggestionsSummary(pipelineId, 28);
  const linhas = (data?.by_stage ?? []).filter((s) => s.suggested > 0);

  if (linhas.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-surface-muted/40 px-3 py-2 text-xs text-text-muted">
      <span className="font-medium text-text">
        {t("Sugestões de etapa pela IA")} · {t("últimos 28 dias")}
      </span>
      {linhas.map((s) => (
        <span key={s.to_stage_id}>
          {s.to_stage_name}: {t("Sugestões:")} {s.suggested} ·{" "}
          {t("aceitas")}{" "}
          {s.acceptance_rate === null ? "—" : `${Math.round(s.acceptance_rate * 100)}%`}
        </span>
      ))}
    </div>
  );
}
