/**
 * Berseba: install-level configuration of the avec agenda API (salon Mayara Morales).
 *
 * The API lives on the VPS's internal Docker network (`http://mayara-avec-api:8000`), so its
 * address is an INSTALL setting, never an organization one: the SSRF guard of
 * `lib/automation/outbound-url.ts` refuses internal hosts chosen per organization, and one
 * install serves many organizations. `AVEC_API_ORG_IDS` says which organizations may use it;
 * for every other organization the `avec_*` tools do not exist (catalog, agent turn, external
 * MCP) and their handlers refuse.
 *
 * Fails closed: no URL, no key, or no organization listed = off for everyone. Never throws.
 */
import { env } from "@/lib/env";

export const AVEC_TOOL_PREFIX = "avec_";

export interface AvecConfig {
  baseUrl: string;
  apiKey: string;
  orgIds: ReadonlySet<string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Pure: the three raw values → the config, or `null` when the integration is off. */
export function parseAvecConfig(raw: {
  url?: string;
  key?: string;
  orgIds?: string;
}): AvecConfig | null {
  const baseUrl = (raw.url ?? "").trim().replace(/\/+$/, "");
  const apiKey = (raw.key ?? "").trim();
  if (!/^https?:\/\/[^/\s]+/.test(baseUrl) || apiKey.length === 0) return null;
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

export function avecConfig(): AvecConfig | null {
  return parseAvecConfig({
    url: env.AVEC_API_URL,
    key: env.AVEC_API_KEY,
    orgIds: env.AVEC_API_ORG_IDS,
  });
}

/** The config when this organization may use avec, else `null`. */
export function avecConfigFor(organizationId: string): AvecConfig | null {
  const config = avecConfig();
  return config?.orgIds.has(organizationId.toLowerCase()) ? config : null;
}

/**
 * True when `toolName` is an avec tool and this organization may not use it. The three places
 * that offer tools call it: the agent turn (`pickToolsFromMcp`), the external MCP server and
 * the catalog served to the agent screen.
 */
export function isAvecToolHiddenFor(toolName: string, organizationId: string): boolean {
  return toolName.startsWith(AVEC_TOOL_PREFIX) && avecConfigFor(organizationId) === null;
}
