/**
 * Berseba (#67): the two buckets of the ad capture routes. The rate limiter is
 * replaced by an in-memory counter so the rotation attack can be replayed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const buckets = vi.hoisted(() => new Map<string, number>());
const warn = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async (key: string, limit: number) => {
    const count = (buckets.get(key) ?? 0) + 1;
    buckets.set(key, count);
    return { allowed: count <= limit };
  },
}));

vi.mock("@/lib/logger", () => ({ logger: { warn } }));

import { checkCaptureRateLimit, ipBucket } from "@/lib/plataformas-de-anuncio/capture-rate-limit";

const IP = "203.0.113.7";

beforeEach(() => {
  buckets.clear();
  warn.mockClear();
});

describe("ipBucket", () => {
  it("keeps an IPv4 address as is", () => {
    expect(ipBucket("203.0.113.7")).toBe("203.0.113.7");
  });

  it("an IPv4-mapped IPv6 address is the plain IPv4", () => {
    expect(ipBucket("::ffff:203.0.113.7")).toBe(ipBucket("203.0.113.7"));
    expect(ipBucket("::FFFF:203.0.113.7")).toBe("203.0.113.7");
    // The same address written in hextets.
    expect(ipBucket("::ffff:cb00:7107")).toBe("203.0.113.7");
    expect(ipBucket("0:0:0:0:0:ffff:cb00:7107")).toBe("203.0.113.7");
  });

  it("collapses an IPv6 address to its /64 prefix, lowercase and expanded", () => {
    expect(ipBucket("2001:DB8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:0db8:0001:0002:0000:0000:0000:0001")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipBucket("::1")).toBe("0:0:0:0::/64");
    expect(ipBucket("::")).toBe("0:0:0:0::/64");
  });

  it("ignores an IPv6 zone id", () => {
    expect(ipBucket("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("two IPv6 addresses in the same /64 share a bucket, another /64 does not", () => {
    expect(ipBucket("2001:db8:1:2::1")).toBe(ipBucket("2001:db8:1:2:ffff:ffff:ffff:ffff"));
    expect(ipBucket("2001:db8:1:2::1")).not.toBe(ipBucket("2001:db8:1:3::1"));
  });

  it.each([
    null,
    "",
    "   ",
    "garbage",
    "999.1.1.1",
    "1.2.3",
    "1.2.3.4:5678",
    "2001:db8::zz",
    "::g",
  ])("invalid or empty input %j counts nothing", (input) => {
    expect(ipBucket(input)).toBeNull();
  });
});

describe("checkCaptureRateLimit", () => {
  it("without an identifiable IP nothing is counted", async () => {
    for (let i = 0; i < 500; i++) {
      expect(await checkCaptureRateLimit("meta", "acme", null)).toBe("allowed");
    }
    expect(buckets.size).toBe(0);
  });

  it("garbage in place of an IP counts nothing either", async () => {
    for (let i = 0; i < 500; i++) {
      expect(await checkCaptureRateLimit("meta", "acme", "not-an-ip")).toBe("allowed");
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
    buckets.set(`capture-ip:${IP}`, 120);
    expect(await checkCaptureRateLimit("meta", "acme", IP)).toBe("blocked");
    expect(buckets.has(`meta-lp:acme:${IP}`)).toBe(false);
  });

  it("another IP is not affected", async () => {
    buckets.set(`capture-ip:${IP}`, 500);
    expect(await checkCaptureRateLimit("meta", "acme", "198.51.100.9")).toBe("allowed");
  });

  it("addresses of one IPv6 /64 share both buckets", async () => {
    const results = [];
    for (let i = 0; i < 31; i++) {
      results.push(await checkCaptureRateLimit("meta", "acme", `2001:db8:1:2::${i.toString(16)}`));
    }
    expect(results[29]).toBe("allowed");
    expect(results[30]).toBe("no_ref");
    expect([...buckets.keys()].sort()).toEqual(
      ["capture-ip:2001:db8:1:2::/64", "meta-lp:acme:2001:db8:1:2::/64"].sort(),
    );
  });

  it("another IPv6 /64 is not affected", async () => {
    buckets.set("capture-ip:2001:db8:1:2::/64", 500);
    expect(await checkCaptureRateLimit("meta", "acme", "2001:db8:1:2::1")).toBe("blocked");
    expect(await checkCaptureRateLimit("meta", "acme", "2001:db8:1:3::1")).toBe("allowed");
  });

  it("an IPv4-mapped address shares the buckets of the plain IPv4", async () => {
    await checkCaptureRateLimit("meta", "acme", `::ffff:${IP}`);
    await checkCaptureRateLimit("meta", "acme", IP);
    expect(buckets.get(`capture-ip:${IP}`)).toBe(2);
    expect(buckets.get(`meta-lp:acme:${IP}`)).toBe(2);
  });

  it("logs both outcomes with platform, org and outcome, and never the IP", async () => {
    buckets.set(`capture-ip:${IP}`, 120);
    await checkCaptureRateLimit("google", "acme", IP);
    buckets.clear();
    buckets.set(`meta-lp:acme:${IP}`, 30);
    await checkCaptureRateLimit("meta", "acme", IP);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, "[anuncios.capture.rate-limit] limit reached", {
      platform: "google",
      org: "acme",
      outcome: "blocked",
    });
    expect(warn).toHaveBeenNthCalledWith(2, "[anuncios.capture.rate-limit] limit reached", {
      platform: "meta",
      org: "acme",
      outcome: "no_ref",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(IP);
  });

  it("does not log when the request is allowed", async () => {
    await checkCaptureRateLimit("meta", "acme", IP);
    expect(warn).not.toHaveBeenCalled();
  });
});
