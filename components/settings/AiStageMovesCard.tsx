"use client";
import { toast } from "sonner";

import { useT } from "@/hooks/i18n/useT";
import { Card } from "@/components/ui/card";
import {
  useAiStageMoves,
  useSalvarAiStageMoves,
  type AiStageMovesMode,
} from "@/hooks/settings/useAiStageMoves";

/**
 * Configurações › Segurança — "Movimentação de etapa pela IA" (WP-A/WP-B),
 * logo abaixo do seletor de nicho (WP5).
 *
 * Radio nativo, como "Modo sombra"/"Exigir de quem administra" na mesma tela
 * — não `RadioGroup` do shadcn: o pacote não está instalado
 * (`@radix-ui/react-radio-group` não está em `package.json`) e a doutrina
 * deste worktree proíbe `pnpm install`. Duas opções com rótulo e uma linha de
 * explicação cada não precisam de um componente novo — `<input
 * type="radio">` estilizado já é o padrão que "Modo sombra" usa para UMA
 * opção com checkbox.
 */
export function AiStageMovesCard() {
  const t = useT();
  const { data: modo, isLoading } = useAiStageMoves();
  const salvar = useSalvarAiStageMoves();

  function escolher(novoModo: AiStageMovesMode) {
    if (novoModo === modo || salvar.isPending) return;
    salvar.mutate(novoModo, {
      onSuccess: () => toast.success(t("Preferência salva.")),
    });
  }

  return (
    <Card className="space-y-3 p-6">
      <h2 className="text-sm font-semibold">{t("Movimentação de etapa pela IA")}</h2>
      <fieldset className="space-y-3" disabled={isLoading || salvar.isPending}>
        <legend className="sr-only">{t("Movimentação de etapa pela IA")}</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="ai-stage-moves-mode"
            className="mt-1"
            checked={modo === "auto"}
            onChange={() => escolher("auto")}
          />
          <span>
            {t("Automática")}
            <span className="mt-1 block text-xs text-muted-foreground">
              {t("o assistente move o negócio de etapa sozinho, conforme a conversa avança")}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="ai-stage-moves-mode"
            className="mt-1"
            checked={modo === "suggest"}
            onChange={() => escolher("suggest")}
          />
          <span>
            {t("Sugerida")}
            <span className="mt-1 block text-xs text-muted-foreground">
              {t("o assistente sugere a etapa e uma pessoa confirma no funil")}
            </span>
          </span>
        </label>
      </fieldset>
      <p className="text-xs text-muted-foreground">
        {t("Ganhou e perdeu nunca são automáticos: são sempre sugeridos, em qualquer modo.")}
      </p>
    </Card>
  );
}
