// @vitest-environment node
/**
 * Berseba: every ad capture route (`app/api/v1/anuncios/<platform>/[org]`) is
 * opened by an anonymous browser, so it must get past the proxy without a
 * session. The Meta one was missing from PUBLIC_PATHS and answered 401 to every
 * click; its route test calls the handler directly, so CI never saw it.
 *
 * Discovery by `git ls-files`, like `tests/unit/callback-oauth-alcancavel.test.ts`:
 * the next platform is covered without anyone remembering this file.
 *
 * The Mirae read routes (`/api/v1/mirae/*`, Bearer-only) are pinned at the bottom: same failure
 * mode (a route test calls the handler directly, the proxy is never in the way).
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { isPublicPath } from "@/lib/auth/public-paths";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://supabase.example",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-test",
    NEXT_PUBLIC_APP_URL: "https://crm.example",
  },
}));

/**
 * Route files under `app/api/v1/anuncios/` that are NOT a capture route and
 * still answer anonymous traffic. Each entry needs a written reason.
 */
const PUBLIC_ON_PURPOSE: Record<string, string> = {};

function routeFiles(): string[] {
  return execFileSync("git", ["ls-files", "app/api/v1/anuncios/**/route.ts"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

/** `app/api/v1/x/route.ts` → `/api/v1/x` */
function routePath(file: string): string {
  return "/" + file.replace(/^app\//, "").replace(/\/route\.ts$/, "");
}

const CAPTURE = /^app\/api\/v1\/anuncios\/[^/]+\/\[org\]\/route\.ts$/;

describe("ad capture routes are reachable without a session", () => {
  const files = routeFiles();
  const captures = files.filter((file) => CAPTURE.test(file));

  it("the scan sees the Google and Meta routes (otherwise it measures nothing)", () => {
    expect(captures).toEqual(
      expect.arrayContaining([
        "app/api/v1/anuncios/google/[org]/route.ts",
        "app/api/v1/anuncios/meta/[org]/route.ts",
      ]),
    );
  });

  it.each(captures)("%s is in PUBLIC_PATHS", (file) => {
    expect(isPublicPath(routePath(file).replace("[org]", "acme"))).toBe(true);
  });

  it("no other route under /api/v1/anuncios/ is public by accident", () => {
    const exposed = files
      .filter((file) => !CAPTURE.test(file) && !(file in PUBLIC_ON_PURPOSE))
      .map(routePath)
      .filter((path) => !path.includes("[") && isPublicPath(path));
    expect(exposed).toEqual([]);
  });
});

describe("the Meta entry is no wider than the route's slug check", () => {
  it.each([
    "/api/v1/anuncios/meta/acme/extra",
    "/api/v1/anuncios/meta/",
    "/api/v1/anuncios/meta",
    "/api/v1/anuncios",
    "/api/v1/anuncios/meta/%2e%2e",
    "/api/v1/anuncios/meta/a%2Fb",
    "/api/v1/anuncios/meta/a.b",
    `/api/v1/anuncios/meta/${"x".repeat(101)}`,
  ])("%s stays private", (path) => {
    expect(isPublicPath(path)).toBe(false);
  });
});

describe("through the proxy", () => {
  async function anonymous(path: string) {
    const { proxy } = await import("@/proxy");
    const { NextRequest } = await import("next/server");
    return proxy(new NextRequest(`https://crm.example${path}?utm_source=meta&utm_campaign=x`));
  }

  it("an anonymous click on the Meta address reaches the route", async () => {
    const response = await anonymous("/api/v1/anuncios/meta/acme");
    expect(response.status).not.toBe(401);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("a sub-path under it still gets 401", async () => {
    const response = await anonymous("/api/v1/anuncios/meta/acme/extra");
    expect(response.status).toBe(401);
  });
});

describe("the Mirae read routes get past the proxy, and nothing next to them does", () => {
  it.each(["/api/v1/mirae/leads", "/api/v1/mirae/pipelines"])(
    "%s is public (Bearer checked in the route)",
    (path) => {
      expect(isPublicPath(path)).toBe(true);
    },
  );

  it.each([
    "/api/v1/mirae",
    "/api/v1/mirae/",
    "/api/v1/mirae/leads/",
    "/api/v1/mirae/leads/11111111-1111-4111-8111-111111111111",
    "/api/v1/mirae/pipelines/x",
    "/api/v1/mirae/contacts",
  ])("%s stays private", (path) => {
    expect(isPublicPath(path)).toBe(false);
  });

  it("every route file under app/api/v1/mirae/ is one of the two", () => {
    const paths = (readdirSync("app/api/v1/mirae", { recursive: true }) as string[])
      .filter((rel) => rel.endsWith("route.ts"))
      .map((rel) => routePath(`app/api/v1/mirae/${rel.split("\\").join("/")}`))
      .sort();
    expect(paths).toEqual(["/api/v1/mirae/leads", "/api/v1/mirae/pipelines"]);
  });
});
