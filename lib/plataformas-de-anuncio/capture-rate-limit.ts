/**
 * Berseba: the rate limit of the ad capture routes
 * (`app/api/v1/anuncios/{google,meta}/[org]`), issue #67.
 *
 * Before, each route had one bucket per (org, IP), checked before the slug was
 * looked up. Two problems:
 *
 * - the bucket rotated with the slug: `/meta/a1`, `/meta/a2`... each got a
 *   fresh one, so a single IP could trigger unbounded organization lookups;
 * - a real visitor over the bucket (many people behind one mobile CGNAT
 *   address) got a blank 429, against the routes' own rule that losing the
 *   attribution is acceptable and losing the lead is not.
 *
 * Now an IP-wide bucket, across organizations and platforms, is checked first:
 * over it the answer is still a bare 429, before any database work. Over the
 * per-(org, IP) bucket the visitor still reaches WhatsApp, only without the
 * ref: the route reads the config and writes nothing.
 *
 * Trust boundary: the IP comes from `X-Forwarded-For` (`clientIp` in
 * `pagina-de-captura.ts`), so the IP-wide bound only holds behind a reverse
 * proxy that OVERWRITES that header with the address it saw. Caddy and Traefik
 * do by default when no trusted proxies are configured (checked on the
 * production VPS on 2026-10-20: the front Caddy site for
 * crm.grupoberseba.com.br has no `trusted_proxies`). If a trusted proxy is
 * configured later (Caddy `trusted_proxies`, a CDN in front), the leftmost
 * entry can be client-supplied and every request could claim a fresh IP:
 * revisit `clientIp` first. Without any proxy there is no header, the IP is
 * null and nothing is counted, which is how the routes already behaved.
 *
 * Both keys use `ipBucket`, not the raw address: one household or one carrier
 * hands out a whole IPv6 /64, so counting full addresses would give an
 * attacker 2^64 fresh buckets.
 */
import { isIP } from "node:net";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { logger } from "@/lib/logger";

export const CAPTURE_WINDOW_SECONDS = 60;

/**
 * Requests per organization and IP, counted for every request that passes the
 * IP-wide bucket (not only clicks that carry a ref). Unchanged from the routes.
 */
const PER_ORG_AND_IP = 30;

/**
 * Requests of any kind per IP, across organizations and platforms: bounds the
 * organization lookups. 120 per minute is far above what one clinic's ad
 * clicks produce from a single carrier address, and it is shared by every
 * organization and both platforms, so it stays a ceiling for abuse, not a
 * tuning knob for normal traffic. Tune it with the
 * `[anuncios.capture.rate-limit]` log.
 */
const PER_IP = 120;

export type CaptureLimit = "allowed" | "no_ref" | "blocked";

/**
 * Log a limit hit once per window per bucket, not once per request: under a
 * flood from one address the denials are thousands of identical lines. The
 * first denial of a window is the one whose `count` is exactly `limit + 1`.
 */
function isFirstDenialOfTheWindow(count: number, limit: number): boolean {
  return count === limit + 1;
}

/** Hextets of an IPv6 address (already validated by `isIP`), fully expanded. */
function expandIpv6(address: string): number[] {
  // A zone id (`fe80::1%eth0`) is not part of the address.
  let text = address.split("%")[0]!.toLowerCase();

  // A dotted IPv4 tail (`::ffff:1.2.3.4`) is two hextets.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const [a, b, c, d] = tail.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const [head = "", rest] = text.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = rest === undefined || rest === "" ? [] : rest.split(":");
  const zeros = rest === undefined ? [] : Array<string>(8 - front.length - back.length).fill("0");
  return [...front, ...zeros, ...back].map((hextet) => parseInt(hextet, 16));
}

/**
 * The unit the buckets count: the address itself for IPv4 (and for an
 * IPv4-mapped IPv6 address, which is the same client), the /64 prefix for any
 * other IPv6 address (`2001:db8:1:2::/64`). Invalid or empty input is `null`,
 * which means nothing is counted.
 */
export function ipBucket(ip: string | null): string | null {
  const address = ip?.trim();
  if (!address) return null;

  const version = isIP(address);
  if (version === 4) return address;
  if (version !== 6) return null;

  const hextets = expandIpv6(address);
  const mapped = hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff;
  if (mapped) {
    const high = hextets[6]!;
    const low = hextets[7]!;
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  const prefix = hextets.slice(0, 4).map((hextet) => hextet.toString(16));
  return `${prefix.join(":")}::/64`;
}

export async function checkCaptureRateLimit(
  platform: "google" | "meta",
  org: string,
  ip: string | null,
): Promise<CaptureLimit> {
  // Same lesson as `lib/auth/rate-limit.ts`: without an identifiable IP there
  // is no count, since one shared bucket would lock every landing page.
  const bucket = ipBucket(ip);
  if (bucket === null) return "allowed";

  // `organizations.slug` is citext and the route accepts uppercase, so
  // `/meta/Acme` and `/meta/acme` are one organization: one bucket, one log name.
  const slug = org.toLowerCase();

  const perIp = await checkRateLimit(`capture-ip:${bucket}`, PER_IP, CAPTURE_WINDOW_SECONDS);
  if (!perIp.allowed) {
    if (isFirstDenialOfTheWindow(perIp.count, PER_IP)) {
      // Never the IP: it is personal data and the log does not need it.
      logger.warn("[anuncios.capture.rate-limit] limit reached", {
        platform,
        org: slug,
        outcome: "blocked",
      });
    }
    return "blocked";
  }

  // The key prefixes are the routes' original ones, so live buckets carry over
  // (for a slug that was already lowercase, the whole key is unchanged).
  const perOrg = await checkRateLimit(
    `${platform}-lp:${slug}:${bucket}`,
    PER_ORG_AND_IP,
    CAPTURE_WINDOW_SECONDS,
  );
  if (!perOrg.allowed) {
    if (isFirstDenialOfTheWindow(perOrg.count, PER_ORG_AND_IP)) {
      logger.warn("[anuncios.capture.rate-limit] limit reached", {
        platform,
        org: slug,
        outcome: "no_ref",
      });
    }
    return "no_ref";
  }
  return "allowed";
}
