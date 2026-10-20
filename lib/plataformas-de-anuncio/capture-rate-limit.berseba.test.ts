/**
 * Berseba (#67): the two buckets of the ad capture routes. The rate limiter is
 * replaced by an in-memory counter so the rotation attack can be replayed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const buckets = vi.hoisted(() => new Map<string, number>());

vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async (key: string, limit: number) => {
    const count = (buckets.get(key) ?? 0) + 1;
    buckets.set(key, count);
    return { allowed: count <= limit };
  },
}));

import { checkCaptureRateLimit } from "@/lib/plataformas-de-anuncio/capture-rate-limit";

const IP = "203.0.113.7";

beforeEach(() => buckets.clear());

describe("checkCaptureRateLimit", () => {
  it("without an identifiable IP nothing is counted", async () => {
    for (let i = 0; i < 500; i++) {
      expect(await checkCaptureRateLimit("meta", "acme", null)).toBe("allowed");
    }
    expect(buckets.size).toBe(0);
  });

  it("over the per-(org, IP) bucket the visitor keeps going, without a ref", async () => {
    const results = [];
    for (let i = 0; i < 31; i++) results.push(await checkCaptureRateLimit("meta", "acme", IP));
    expect(results.slice(0, 30).every((r) => r === "allowed")).toBe(true);
    expect(results[30]).toBe("no_ref");
  });

  it("keeps the routes' original per-org keys", async () => {
    await checkCaptureRateLimit("google", "acme", IP);
    await checkCaptureRateLimit("meta", "acme", IP);
    expect([...buckets.keys()]).toEqual(
      expect.arrayContaining([`google-lp:acme:${IP}`, `meta-lp:acme:${IP}`]),
    );
  });

  it("rotating the slug no longer gives a fresh bucket: the IP-wide one blocks", async () => {
    const results = [];
    for (let i = 0; i < 121; i++) {
      results.push(await checkCaptureRateLimit(i % 2 ? "meta" : "google", `slug-${i}`, IP));
    }
    expect(results.slice(0, 120).every((r) => r === "allowed")).toBe(true);
    expect(results[120]).toBe("blocked");
  });

  it("the IP-wide bucket is checked first, so a blocked IP costs no per-org count", async () => {
    buckets.set(`lp-ip:${IP}`, 120);
    expect(await checkCaptureRateLimit("meta", "acme", IP)).toBe("blocked");
    expect(buckets.has(`meta-lp:acme:${IP}`)).toBe(false);
  });

  it("another IP is not affected", async () => {
    buckets.set(`lp-ip:${IP}`, 500);
    expect(await checkCaptureRateLimit("meta", "acme", "198.51.100.9")).toBe("allowed");
  });
});
