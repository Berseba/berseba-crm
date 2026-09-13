/**
 * A REGRA PURA de "mover ou sugerir" — não toca banco, não sabe de HTTP.
 *
 * Modelo de três níveis de confiança (ver `lib/organizacoes/ai-stage-moves.ts`):
 *  1. determinístico → automático;
 *  2. classificação → a IA sugere, o humano confirma;
 *  3. evento de NEGÓCIO (ganhou/perdeu) → NUNCA inferido de conversa.
 *
 * O nível 3 é regra DURA e independente do knob: etapa de destino marcada
 * `is_won` ou `is_lost` em `crm_stages` é SEMPRE sugestão, mesmo com
 * `ai_stage_moves = "auto"`. Fechar um negócio é a decisão de maior
 * consequência do funil (dispara `crm_leads_closed_at_consistency`, encerra a
 * demanda, muda métrica de conversão) — "auto" cobre avanço de etapa ATIVA,
 * nunca o desfecho.
 */
import type { AiStageMovesMode } from "@/lib/organizacoes/ai-stage-moves";

export interface EstagioDeDestino {
  is_won: boolean;
  is_lost: boolean;
}

export interface DecideStageMoveInput {
  mode: AiStageMovesMode;
  targetStage: EstagioDeDestino;
}

export type StageMoveReason = "auto" | "suggest_mode" | "terminal_stage";

export interface StageMoveDecision {
  action: "move" | "suggest";
  reason: StageMoveReason;
}

/**
 * `targetStage.is_won || is_lost` vence SEMPRE — checado antes do knob, porque
 * é regra dura, não preferência configurável. Só depois disso o knob decide
 * entre mover (nível 1) e sugerir (nível 2).
 */
export function decideStageMove(input: DecideStageMoveInput): StageMoveDecision {
  if (input.targetStage.is_won || input.targetStage.is_lost) {
    return { action: "suggest", reason: "terminal_stage" };
  }
  if (input.mode === "suggest") {
    return { action: "suggest", reason: "suggest_mode" };
  }
  return { action: "move", reason: "auto" };
}
