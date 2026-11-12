/**
 * Berseba: install-level configuration of Voz, Berseba's voice product (the Bia calls a lead over
 * WhatsApp and writes the report back here; Berseba/berseba issue #232).
 *
 * Same shape as the Mirae gate (`lib/integrations/mirae/config.ts`): an INSTALL setting, and
 * `VOZ_API_ORG_IDS` says which CRM organizations get the "Ligar com a Bia" button. For every other
 * organization the button does not exist and `POST /api/v1/voz/calls` refuses.
 *
 * Fails closed: no URL, key or organization listed = off for everyone. Never throws.
 */
import { env } from "@/lib/env";

export interface VozConfig {
  /** Voz's origin, e.g. `https://voz.grupoberseba.com.br`; routes hang from it (`/v1/calls`). */
  baseUrl: string;
  /** The tenant's `voz_…` API key (created in Voz's console, Linha › Chaves da API). */
  apiKey: string;
  orgIds: ReadonlySet<string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Pure: the three raw values → the config, or `null` when the integration is off. */
export function parseVozConfig(raw: { url?: string; key?: string; orgIds?: string }): VozConfig | null {
  // A pasted `/v1` or `/v1/calls` tail is tolerated.
  const baseUrl = (raw.url ?? "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1(\/calls)?$/, "");
  const apiKey = (raw.key ?? "").trim();
  if (!/^https?:\/\/[^/\s]+$/.test(baseUrl) || !apiKey.startsWith("voz_")) return null;
  // An entry that is not a uuid is ignored, and ignoring it is refusing it.
  const orgIds = new Set(
    (raw.orgIds ?? "")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter((id) => UUID.test(id)),
  );
  if (orgIds.size === 0) return null;
  return { baseUrl, apiKey, orgIds };
}

export function vozConfig(): VozConfig | null {
  return parseVozConfig({ url: env.VOZ_API_URL, key: env.VOZ_API_KEY, orgIds: env.VOZ_API_ORG_IDS });
}

/** The config when this organization may ask the Bia for calls, else `null`. */
export function vozConfigFor(organizationId: string): VozConfig | null {
  const config = vozConfig();
  return config?.orgIds.has(organizationId.toLowerCase()) ? config : null;
}
