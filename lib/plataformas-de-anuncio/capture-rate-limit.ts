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
 */
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";

export const CAPTURE_WINDOW_SECONDS = 60;

/** Clicks with a ref per organization and IP. Unchanged from the routes. */
const PER_ORG_AND_IP = 30;

/** Requests of any kind per IP, across organizations: bounds the lookups. */
const PER_IP = 120;

export type CaptureLimit = "allowed" | "no_ref" | "blocked";

export async function checkCaptureRateLimit(
  platform: "google" | "meta",
  org: string,
  ip: string | null,
): Promise<CaptureLimit> {
  // Same lesson as `lib/auth/rate-limit.ts`: without an identifiable IP there
  // is no count, since one shared bucket would lock every landing page.
  if (ip === null) return "allowed";

  const perIp = await checkRateLimit(`lp-ip:${ip}`, PER_IP, CAPTURE_WINDOW_SECONDS);
  if (!perIp.allowed) return "blocked";

  // The key prefixes are the routes' original ones, so live buckets carry over.
  const perOrg = await checkRateLimit(
    `${platform}-lp:${org}:${ip}`,
    PER_ORG_AND_IP,
    CAPTURE_WINDOW_SECONDS,
  );
  return perOrg.allowed ? "allowed" : "no_ref";
}
