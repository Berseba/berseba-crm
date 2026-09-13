/**
 * O KNOB "sugestão de etapa" — `organizations.settings.crm.ai_stage_moves`.
 *
 * Modelo de três níveis de confiança para automação de IA no funil:
 *  1. determinístico → automático (não é este knob — é o que já acontecia);
 *  2. classificação → a IA SUGERE, o humano CONFIRMA (este knob, valor `"suggest"`);
 *  3. evento de negócio (ganhou/perdeu) → NUNCA inferido de conversa — regra
 *     dura em `lib/leads/stage-move-policy.ts`, independente deste knob.
 *
 * `"auto"` é o valor ausente/padrão: toda instalação existente continua movendo
 * o card sozinha (compatível — ninguém que não ligou nada muda de
 * comportamento). Promoção de "suggest" para "auto" é medição (taxa de aceite
 * em `GET /leads/stage-suggestions/summary`), nunca otimismo de quem programa.
 *
 * ─── Leitura em dois transportes, o mesmo padrão de `lib/ai/modo-sombra/leitura.ts` ──
 *
 * `sincronizaEstagioDoAgente` roda no agent-engine com `pg.Pool` na mão; a rota
 * de configurações e o MCP só têm `supabase-js`. Em vez de duas funções com
 * nomes gêmeos, `lerAiStageMoves` aceita os dois e escolhe por duck-typing.
 *
 * ─── Fail-closed, e a razão é MEDIDA, não hipótese ─────────────────────────
 *
 * Erro de leitura do banco vira `"suggest"`, nunca `"auto"`: se o knob não pode
 * ser confirmado, a decisão mais segura é pedir confirmação humana antes de
 * mexer no funil do cliente — o inverso (assumir automático quando a leitura
 * falhou) moveria o card sozinho justamente no instante em que ninguém pode
 * garantir qual configuração vale. Um cinto que falha calado não é cinto.
 */
import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export const AI_STAGE_MOVES_MODES = ["auto", "suggest"] as const;
export type AiStageMovesMode = (typeof AI_STAGE_MOVES_MODES)[number];

export const AI_STAGE_MOVES_DEFAULT: AiStageMovesMode = "auto";

/** Fail-closed: erro de leitura NUNCA vira "auto" — ver cabeçalho do arquivo. */
export const AI_STAGE_MOVES_FAIL_CLOSED: AiStageMovesMode = "suggest";

/** Schema do valor gravado em `organizations.settings.crm.ai_stage_moves`. */
export const aiStageMovesModeSchema = z.enum(AI_STAGE_MOVES_MODES);

function ehPool(client: pg.Pool | SupabaseClient): client is pg.Pool {
  return typeof (client as Partial<pg.Pool>).query === "function";
}

function normaliza(valor: unknown): AiStageMovesMode {
  const parsed = aiStageMovesModeSchema.safeParse(valor);
  return parsed.success ? parsed.data : AI_STAGE_MOVES_DEFAULT;
}

async function viaPg(pool: pg.Pool, organizationId: string): Promise<AiStageMovesMode> {
  const { rows } = await pool.query<{ modo: unknown }>(
    `select settings->'crm'->>'ai_stage_moves' as modo from public.organizations where id = $1`,
    [organizationId],
  );
  return normaliza(rows[0]?.modo ?? null);
}

async function viaSupabase(
  client: SupabaseClient,
  organizationId: string,
): Promise<AiStageMovesMode> {
  const { data, error } = await client
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) throw new Error(`ai_stage_moves: leitura da organização falhou — ${error.message}`);

  const settings = (data?.settings as Record<string, unknown> | null) ?? {};
  const crm = (settings.crm as Record<string, unknown> | null) ?? {};
  return normaliza(crm.ai_stage_moves ?? null);
}

/**
 * Lê o modo do knob para a organização. Ausência de configuração (org nova,
 * clone que nunca abriu a tela) é `"auto"` — nunca lança e nunca escala para
 * `"suggest"` por si só; só um ERRO de leitura faz isso (fail-closed).
 *
 * Erro é PROPAGADO (lançado), como `lerModoSombra`: quem chama decide o que
 * fazer, e os chamadores deste repo tratam exceção como `"suggest"` — nunca
 * como `"auto"`, pelo motivo do cabeçalho.
 */
export async function lerAiStageMoves(
  client: pg.Pool | SupabaseClient,
  organizationId: string,
): Promise<AiStageMovesMode> {
  return ehPool(client) ? viaPg(client, organizationId) : viaSupabase(client, organizationId);
}

/**
 * `lerAiStageMoves` fail-closed — nunca lança. Erro de leitura vira `"suggest"`
 * (nível 2, IA sugere/humano confirma), nunca `"auto"`. Uso recomendado para
 * quem está prestes a mover um card sozinho: `sincronizaEstagioDoAgente`.
 */
export async function lerAiStageMovesFailClosed(
  client: pg.Pool | SupabaseClient,
  organizationId: string,
): Promise<AiStageMovesMode> {
  try {
    return await lerAiStageMoves(client, organizationId);
  } catch {
    return AI_STAGE_MOVES_FAIL_CLOSED;
  }
}
