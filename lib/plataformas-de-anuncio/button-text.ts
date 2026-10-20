/**
 * Berseba: the message of the button the visitor tapped, as the capture route
 * receives it in `&texto=` (URL-decoded by `URLSearchParams`).
 *
 * The site has several WhatsApp buttons and each one has its own message. The
 * route used to answer every click with the configured template, so the lead
 * always opened the same text no matter which button was tapped. When the page
 * sends `texto`, that message is the one that goes to WhatsApp; without it the
 * route behaves as before.
 *
 * The value is untrusted input from the query string of an anonymous request,
 * and it ends up as the pre-filled text of a conversation with the clinic:
 *
 * - every `[ref:...]` and `[dk1:...]` marker is removed. The inbound side reads
 *   the FIRST marker it finds in the first message, so a link carrying a forged
 *   `[ref:...]` would otherwise attribute the lead to someone else's click.
 *   The route appends its own `[ref:XXXXXX]` after the text, never inside it;
 * - whitespace runs collapse to one space (a pasted newline or tab in a URL is
 *   not a message);
 * - the length is capped by code points, so an emoji is never cut in half.
 *
 * It never reaches `utm` or `query_raw`: those keep only the closed list of
 * campaign keys (`normalizarUtm`).
 */

/** Longest message accepted, in code points. A button message is a sentence. */
export const MAX_BUTTON_TEXT_LENGTH = 300;

const ATTRIBUTION_MARKER = /\[(ref|dk1):[^\]]*\]/gi;

/** The cleaned message, or `null` when there is nothing left to send. */
export function buttonText(raw: string | null): string | null {
  if (raw === null) return null;

  const cleaned = raw.replace(ATTRIBUTION_MARKER, "").replace(/\s+/g, " ").trim();
  if (cleaned === "") return null;

  // The cut can leave a trailing space; the first character is never one.
  return Array.from(cleaned).slice(0, MAX_BUTTON_TEXT_LENGTH).join("").trim();
}
