/**
 * Berseba: install-level configuration of the Mirae agenda API (Fiore Pilates).
 *
 * Mirae is the studio's agenda SaaS. Its API v1 takes one key per studio and the studio's slug in
 * the path (`/v1/orgs/{slug}/...`). Same shape as the avec gate (`lib/integrations/avec/config.ts`):
 * an INSTALL setting, and `MIRAE_API_ORG_IDS` says which CRM organizations may use it; for every
 * other organization the `mirae_*` tools do not exist (catalog, agent turn, external MCP) and
 * their handlers refuse.
 *
 * Fails closed: no URL, key, slug or organization listed = off for everyone. Never throws.
 */
import { env } from "@/lib/env";

export const MIRAE_TOOL_PREFIX = "mirae_";

export interface MiraeConfig {
  /** `https://host/api/v1/orgs/{slug}`: every route of the client hangs from it. */
  orgUrl: string;
  apiKey: string;
  orgIds: ReadonlySet<string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** Pure: the four raw values → the config, or `null` when the integration is off. */
export function parseMiraeConfig(raw: {
  url?: string;
  key?: string;
  slug?: string;
  orgIds?: string;
}): MiraeConfig | null {
  // The server root (`https://host/api`); a pasted `/v1` or `/v1/orgs` tail is tolerated.
  const base = (raw.url ?? "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1(\/orgs)?$/, "");
  const apiKey = (raw.key ?? "").trim();
  const slug = (raw.slug ?? "").trim().toLowerCase();
  if (!/^https?:\/\/[^/\s]+/.test(base) || apiKey.length === 0 || !SLUG.test(slug)) return null;
  // An entry that is not a uuid is ignored, and ignoring it is refusing it.
  const orgIds = new Set(
    (raw.orgIds ?? "")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter((id) => UUID.test(id)),
  );
  if (orgIds.size === 0) return null;
  return { orgUrl: `${base}/v1/orgs/${slug}`, apiKey, orgIds };
}

export function miraeConfig(): MiraeConfig | null {
  return parseMiraeConfig({
    url: env.MIRAE_API_URL,
    key: env.MIRAE_API_KEY,
    slug: env.MIRAE_API_ORG_SLUG,
    orgIds: env.MIRAE_API_ORG_IDS,
  });
}

/** The config when this organization may use Mirae, else `null`. */
export function miraeConfigFor(organizationId: string): MiraeConfig | null {
  const config = miraeConfig();
  return config?.orgIds.has(organizationId.toLowerCase()) ? config : null;
}

/**
 * True when `toolName` is a Mirae tool and this organization may not use it. Called by the same
 * three places as `isAvecToolHiddenFor`: the agent turn, the external MCP server and the catalog
 * served to the agent screen.
 */
export function isMiraeToolHiddenFor(toolName: string, organizationId: string): boolean {
  return toolName.startsWith(MIRAE_TOOL_PREFIX) && miraeConfigFor(organizationId) === null;
}
