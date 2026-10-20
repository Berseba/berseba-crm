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
 * - every `[ref:...]` and `[dk1:...]` marker is removed, repeatedly: removing
 *   one can close up the pieces of another (`[re[ref:]f:ABCDEF]` becomes
 *   `[ref:ABCDEF]`), so a single pass is bypassable by nesting. The inbound side
 *   reads the FIRST marker it finds in the first message, so a link carrying a
 *   forged `[ref:...]` would otherwise attribute the lead to someone else's
 *   click. The route appends its own `[ref:XXXXXX]` after the text, never
 *   inside it;
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

/**
 * Passes of the marker removal. Each pass that changes the text peels one
 * level of nesting, and an honest message has none, so a few are plenty.
 */
const MAX_STRIP_PASSES = 8;

/**
 * Removes markers until the text stops changing. `null` when it still changes
 * after the last pass: nesting that deep is not a message, and returning a
 * half-stripped text could hand a marker through. Whitespace collapsing, trim
 * and the cap come after, and none of them can build a marker: collapsing swaps
 * a run of whitespace for one space and never makes two other characters
 * adjacent, trim only touches the ends, and the cap can only cut a marker, which
 * then lacks its closing bracket.
 */
function stripMarkers(text: string): string | null {
  let current = text;
  for (let pass = 0; pass <= MAX_STRIP_PASSES; pass += 1) {
    const next = current.replace(ATTRIBUTION_MARKER, "");
    if (next === current) return current;
    current = next;
  }
  return null;
}

/** The cleaned message, or `null` when there is nothing left to send. */
export function buttonText(raw: string | null): string | null {
  if (raw === null) return null;

  const stripped = stripMarkers(raw);
  if (stripped === null) return null;

  const cleaned = stripped.replace(/\s+/g, " ").trim();
  if (cleaned === "") return null;

  // The cut can leave a trailing space; the first character is never one.
  return Array.from(cleaned).slice(0, MAX_BUTTON_TEXT_LENGTH).join("").trim();
}
