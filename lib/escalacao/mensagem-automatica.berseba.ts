/**
 * Berseba: a message another system sends from the business's own WhatsApp
 * number is not a person answering from the phone.
 *
 * The QR-code channel ingestion reads every `fromMe` message that is not our own echo as
 * "a person took over from the phone" and pauses the AI in that conversation
 * (`pausarIaPorAtendimentoManual`). A scheduling system connected to the same
 * number sends reminders the same way, so each reminder paused the agent. At the
 * Mayara Morales salon (avec), 228 of the 239 such messages from 14/10 to 20/10
 * were avec reminders. The return reminder carries a "Sim, quero saber mais"
 * button that avec does not answer: 5 clients tapped it within the pause and
 * nobody replied.
 *
 * Each organization lists the fixed snippets of those automatic messages in
 * `organizations.settings.automated_outbound_patterns` (configuration, no
 * migration). A `fromMe` message whose text contains one of them does not pause
 * the agent. Everything else (a real phone reply, the `#on`/`#off` commands)
 * behaves as before.
 *
 * Matching is case- and accent-insensitive substring matching on the message
 * body. Fail-closed towards today's behavior: no setting, a bad value or a read
 * error means "not automatic", so the pause happens as it always did.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/** Shortest snippet accepted: a 1–2 letter pattern would match any reply. */
const MIN_PATTERN_LENGTH = 8;

export function normalizarParaComparar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Reads the list defensively: `settings` is free jsonb. */
export function lerPadroesAutomaticos(settings: unknown): string[] {
  const lista = (settings as { automated_outbound_patterns?: unknown } | null)?.automated_outbound_patterns;
  if (!Array.isArray(lista)) return [];
  return lista
    .filter((p): p is string => typeof p === "string")
    .map(normalizarParaComparar)
    .filter((p) => p.length >= MIN_PATTERN_LENGTH);
}

/** Pure rule: does this body contain one of the organization's automatic snippets? */
export function casaComPadraoAutomatico(corpo: string | null | undefined, padroes: readonly string[]): boolean {
  if (!corpo || padroes.length === 0) return false;
  const texto = normalizarParaComparar(corpo);
  return padroes.some((p) => texto.includes(p));
}

/**
 * Is this `fromMe` message an automatic message from another system, per the
 * organization's settings? Never throws.
 */
export async function ehMensagemAutomaticaDeOutroSistema(
  admin: SupabaseClient,
  organizationId: string,
  corpo: string | null | undefined,
): Promise<boolean> {
  if (!corpo) return false;
  try {
    const { data, error } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const automatica = casaComPadraoAutomatico(
      corpo,
      lerPadroesAutomaticos((data as { settings?: unknown } | null)?.settings),
    );
    if (automatica) {
      logger.info("[mensagem-automatica] fromMe message from another system — AI not paused", {
        organization_id: organizationId,
      });
    }
    return automatica;
  } catch (err) {
    logger.warn("[mensagem-automatica] settings read failed — treating as a person", {
      organization_id: organizationId,
      detail: err instanceof Error ? err.message.slice(0, 160) : String(err),
    });
    return false;
  }
}
