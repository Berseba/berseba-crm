/**
 * Berseba: thin server-side client of the Jo OS evaluation agenda (Instituto Jordão).
 *
 * Contract: the Edge Function `crm-agenda-avaliacao` of Jo OS
 * (`supabase/functions/crm-agenda-avaliacao/index.ts` in samuelnishioka/jo.-sales-dashboard).
 * It only reads: Jo OS computes the free slots (60 min evaluations, the evaluators' schedule,
 * one evaluation per evaluator at a time, travel time between units) and nothing is written.
 *
 * Every failure becomes a `JoOsApiError` carrying `status` and a stable `code`. `status: 0` = no
 * usable HTTP answer (`timeout`, `network_error`, `invalid_response`).
 */
import { z } from "zod";

import type { JoOsConfig } from "./config";

export const JOOS_TIMEOUT_MS = 10_000;

export class JoOsApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JoOsApiError";
  }
}

const slotSchema = z.object({
  unidade_id: z.string(),
  unidade: z.string().nullable(),
  /** `YYYY-MM-DD` in Jo OS's time zone. */
  dia: z.string(),
  /** `HH:MM`. */
  hora: z.string(),
  inicio: z.string(),
  fim: z.string(),
  avaliadores_livres: z.number().int(),
  avaliador_sugerido: z.string().nullable(),
});
export type JoOsSlot = z.infer<typeof slotSchema>;

const answerSchema = z.discriminatedUnion("situacao", [
  z.object({
    situacao: z.literal("ok"),
    consultado_em: z.string(),
    fuso: z.string(),
    duracao_min: z.number().int(),
    horarios: z.array(slotSchema),
  }),
  /** The Jo OS switch `crm_agenda_consulta` is off. */
  z.object({ situacao: z.literal("desligado") }),
]);
export type JoOsAnswer = z.infer<typeof answerSchema>;

const problemSchema = z.object({ situacao: z.string() });

export async function listEvaluationSlots(
  config: JoOsConfig,
  params: { de?: string; ate?: string } = {},
): Promise<JoOsAnswer> {
  let response: Response;
  try {
    response = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-crm-agenda-secret": config.secret,
      },
      body: JSON.stringify({ acao: "horarios", de: params.de, ate: params.ate }),
      signal: AbortSignal.timeout(JOOS_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new JoOsApiError(0, timedOut ? "timeout" : "network_error", "Jo OS got no answer");
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = problemSchema.safeParse(payload);
    throw new JoOsApiError(
      response.status,
      problem.success ? problem.data.situacao : `http_${response.status}`,
      `Jo OS answered ${response.status}`,
    );
  }
  const parsed = answerSchema.safeParse(payload);
  if (!parsed.success) throw new JoOsApiError(0, "invalid_response", "Jo OS: unexpected body");
  return parsed.data;
}
