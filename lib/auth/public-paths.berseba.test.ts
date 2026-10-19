/**
 * Berseba: the Meta UTM capture route must get past the proxy without a
 * session, like its Google sibling. The route test
 * (`tests/unit/meta-ads-captura-de-utm.test.ts`) calls the handler directly,
 * so it never saw the proxy answer 401 to every anonymous click.
 */
import { describe, it, expect } from "vitest";

import { isPublicPath } from "@/lib/auth/public-paths";

describe("isPublicPath: ad capture routes", () => {
  it("lets the Meta capture route through without a session", () => {
    expect(isPublicPath("/api/v1/anuncios/meta/fiore-pilates-e-fisioterapia")).toBe(true);
  });

  it("keeps the Google sibling public", () => {
    expect(isPublicPath("/api/v1/anuncios/google/fiore-pilates-e-fisioterapia")).toBe(true);
  });

  it("does not open a sub-path under the Meta route", () => {
    expect(isPublicPath("/api/v1/anuncios/meta/fiore-pilates-e-fisioterapia/extra")).toBe(false);
  });

  it("does not open the bare prefixes", () => {
    expect(isPublicPath("/api/v1/anuncios/meta")).toBe(false);
    expect(isPublicPath("/api/v1/anuncios/meta/")).toBe(false);
    expect(isPublicPath("/api/v1/anuncios")).toBe(false);
  });
});
