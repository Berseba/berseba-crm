/**
 * Berseba: install-level configuration of the Jo OS evaluation agenda (Instituto Jordão).
 *
 * Jo OS is the clinic's own system. Its Edge Function `crm-agenda-avaliacao` answers the free
 * evaluation slots (repository samuelnishioka/jo.-sales-dashboard). It takes one shared secret in
 * the `x-crm-agenda-secret` header. Same shape as the avec and Mirae gates: an INSTALL setting, and
 * `JOOS_AGENDA_ORG_IDS` says which CRM organizations may use it; for every other organization the
 * `joos_*` tools do not exist (catalog, agent turn, external MCP) and their handlers refuse.
 *
 * Fails closed: no URL, secret or organization listed = off for everyone. Never throws.
 */
import { env } from "@/lib/env";

export const JOOS_TOOL_PREFIX = "joos_";

export interface JoOsConfig {
  /** The function URL, e.g. `https://<project>.supabase.co/functions/v1/crm-agenda-avaliacao`. */
  url: string;
  secret: string;
  orgIds: ReadonlySet<string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Pure: the three raw values → the config, or `null` when the integration is off. */
export function parseJoOsConfig(raw: { url?: string; secret?: string; orgIds?: string }): JoOsConfig | null {
  const url = (raw.url ?? "").trim().replace(/\/+$/, "");
  const secret = (raw.secret ?? "").trim();
  if (!/^https:\/\/[^/\s]+\/\S+$/.test(url) || secret.length === 0) return null;
  // An entry that is not a uuid is ignored, and ignoring it is refusing it.
  const orgIds = new Set(
    (raw.orgIds ?? "")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter((id) => UUID.test(id)),
  );
  if (orgIds.size === 0) return null;
  return { url, secret, orgIds };
}

export function joOsConfig(): JoOsConfig | null {
  return parseJoOsConfig({
    url: env.JOOS_AGENDA_URL,
    secret: env.JOOS_AGENDA_SECRET,
    orgIds: env.JOOS_AGENDA_ORG_IDS,
  });
}

/** The config when this organization may use Jo OS, else `null`. */
export function joOsConfigFor(organizationId: string): JoOsConfig | null {
  const config = joOsConfig();
  return config?.orgIds.has(organizationId.toLowerCase()) ? config : null;
}

/**
 * True when `toolName` is a Jo OS tool and this organization may not use it. Called by the same
 * three places as `isMiraeToolHiddenFor`: the agent turn, the external MCP server and the catalog
 * served to the agent screen.
 */
export function isJoOsToolHiddenFor(toolName: string, organizationId: string): boolean {
  return toolName.startsWith(JOOS_TOOL_PREFIX) && joOsConfigFor(organizationId) === null;
}
