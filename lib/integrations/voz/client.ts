/**
 * Berseba: the one call the CRM makes to Voz — `POST /v1/calls` (Berseba/berseba issue #232):
 * the tenant's agent calls this number, and the lead's id goes along so the report comes back to
 * this card (`POST /api/v1/voz/call-ended`).
 *
 * Voz's answers: `202 {call_id}`; `409` opted out or already calling that number; `423` the agent is
 * paused; `429` the line's daily limit; `401` a bad key; `404` no line. Each one becomes a code the
 * button turns into a sentence (`MENSAGEM_DO_PEDIDO`). Never throws.
 */
import type { VozConfig } from "./config";

export const VOZ_TIMEOUT_MS = 8000;

export type PedidoDeLigacao =
  | { ok: true; callId: string }
  | {
      ok: false;
      codigo:
        | "opted_out"
        | "in_progress"
        | "suspended"
        | "daily_limit"
        | "unauthorized"
        | "no_line"
        | "bad_phone"
        | "unavailable";
    };

const CODIGOS = new Set([
  "opted_out",
  "in_progress",
  "suspended",
  "daily_limit",
  "unauthorized",
  "no_line",
  "bad_phone",
]);

export async function pedirLigacaoNaVoz(
  config: VozConfig,
  input: { phone: string; leadId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<PedidoDeLigacao> {
  let res: Response;
  try {
    res = await fetchImpl(`${config.baseUrl}/v1/calls`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        to: input.phone,
        agent: "bia",
        lead_ref: { connector: "crm-berseba", id: input.leadId },
      }),
      signal: AbortSignal.timeout(VOZ_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, codigo: "unavailable" };
  }
  const body = (await res.json().catch(() => null)) as { call_id?: unknown; error?: unknown } | null;
  if (res.status === 202 && typeof body?.call_id === "string") return { ok: true, callId: body.call_id };
  const codigo = typeof body?.error === "string" && CODIGOS.has(body.error) ? body.error : null;
  if (codigo) return { ok: false, codigo: codigo as Exclude<PedidoDeLigacao, { ok: true }>["codigo"] };
  if (res.status === 401) return { ok: false, codigo: "unauthorized" };
  return { ok: false, codigo: "unavailable" };
}

/** What the team reads under the button, in Portuguese (the dictionary translates). */
export const MENSAGEM_DO_PEDIDO: Record<Exclude<PedidoDeLigacao, { ok: true }>["codigo"], string> = {
  opted_out: "Este número pediu para não receber ligações.",
  in_progress: "A Bia já está ligando para este número.",
  suspended: "A Bia está pausada. Ative-a no console da Voz.",
  daily_limit: "A linha da Bia chegou ao limite de ligações de hoje.",
  unauthorized: "A chave da Voz não vale mais. Avise quem administra o CRM.",
  no_line: "A Bia não tem uma linha de WhatsApp ativa.",
  bad_phone: "O telefone do contato não parece um celular válido.",
  unavailable: "A Voz não respondeu. Tente de novo em instantes.",
};
