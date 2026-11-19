/**
 * Berseba: the Asaas invoice link a Mirae charge notice carries (berseba-crm#127, Mirae ADR-052
 * addendum 2026-11-18).
 *
 * One rule, read by the endpoint (`reminder-message.ts`, 422 `invalid_charge`) and again by the
 * worker right before the agent turn (`mirae-reminder-turn.berseba.ts`): the link is copied
 * character by character into a WhatsApp message, so only the exact shape Asaas returns as
 * `invoiceUrl` is accepted, `https://www.asaas.com/i/<id>`, and the sandbox host only outside
 * production.
 */

/** The invoice id: what Asaas puts after `/i/`. */
const INVOICE_PATH = /^\/i\/[A-Za-z0-9]{4,64}$/;

export const MAX_CHARGE_LINK_LENGTH = 200;

/** Hosts whose invoice links are accepted here. The sandbox one never in production. */
export function asaasInvoiceHosts(nodeEnv: string | undefined = process.env.NODE_ENV): readonly string[] {
  return nodeEnv === "production" ? ["www.asaas.com"] : ["www.asaas.com", "sandbox.asaas.com"];
}

/**
 * Pure: the link exactly as it will be stored and sent, or `null`. It must already be in that
 * exact form (no normalization): `https`, an accepted host, `/i/<id>`, no credentials, port, query
 * nor fragment, printable ASCII only (no invisible character, no full-width look-alike, no `\` nor
 * `@`).
 */
export function asaasInvoiceLinkOf(raw: unknown, nodeEnv?: string): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_CHARGE_LINK_LENGTH) return null;
  if (!/^[\x21-\x7e]+$/.test(raw) || /[\\@]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const ok =
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.search === "" &&
    url.hash === "" &&
    asaasInvoiceHosts(nodeEnv).includes(url.hostname) &&
    INVOICE_PATH.test(url.pathname) &&
    // Nothing the parser normalized away: what was validated is what goes out.
    url.href === raw;
  return ok ? raw : null;
}

export function isAsaasInvoiceLink(raw: unknown, nodeEnv?: string): boolean {
  return asaasInvoiceLinkOf(raw, nodeEnv) !== null;
}
