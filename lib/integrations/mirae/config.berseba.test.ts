import { describe, expect, it, vi } from "vitest";

const ORG = "0cc6e9e0-a9b0-42a4-951b-a0cb1e554a48";
const OTHER = "99999999-9999-4999-8999-999999999999";

vi.mock("@/lib/env", () => ({
  env: {
    MIRAE_API_URL: "https://mirae.example.com/api/",
    MIRAE_API_KEY: "mirae_sk_test",
    MIRAE_API_ORG_SLUG: "fiore-pilates-e-fisioterapia",
    MIRAE_API_ORG_IDS: ` ${ORG.toUpperCase()} , not-a-uuid`,
  },
}));

const { isMiraeToolHiddenFor, miraeConfigFor, parseMiraeConfig } = await import("./config");

const full = { url: "https://m.example/api", key: "k", slug: "fiore", orgIds: ORG };

describe("parseMiraeConfig", () => {
  it("is off unless URL, key, slug and at least one organization are set", () => {
    expect(parseMiraeConfig({})).toBeNull();
    expect(parseMiraeConfig({ ...full, url: "" })).toBeNull();
    expect(parseMiraeConfig({ ...full, url: "mirae.example/api" })).toBeNull();
    expect(parseMiraeConfig({ ...full, key: " " })).toBeNull();
    expect(parseMiraeConfig({ ...full, slug: "" })).toBeNull();
    expect(parseMiraeConfig({ ...full, slug: "../admin" })).toBeNull();
    expect(parseMiraeConfig({ ...full, orgIds: "nope" })).toBeNull();
  });

  it("builds the studio's base from the server root, tolerating a pasted /v1 or /v1/orgs", () => {
    for (const url of [
      "https://m.example/api",
      "https://m.example/api/",
      "https://m.example/api/v1",
      "https://m.example/api/v1/orgs/",
    ]) {
      expect(parseMiraeConfig({ ...full, url })?.orgUrl, url).toBe(
        "https://m.example/api/v1/orgs/fiore",
      );
    }
  });

  it("keeps only valid organization ids, lowercased", () => {
    expect(parseMiraeConfig({ ...full, orgIds: `${ORG.toUpperCase()},bad` })?.orgIds).toEqual(
      new Set([ORG]),
    );
  });
});

describe("the install-level gate", () => {
  it("enables only the listed organization", () => {
    expect(miraeConfigFor(ORG)?.orgUrl).toBe(
      "https://mirae.example.com/api/v1/orgs/fiore-pilates-e-fisioterapia",
    );
    expect(miraeConfigFor(OTHER)).toBeNull();
  });

  it("hides only Mirae tools, and only from other organizations", () => {
    expect(isMiraeToolHiddenFor("mirae_book", OTHER)).toBe(true);
    expect(isMiraeToolHiddenFor("mirae_book", ORG)).toBe(false);
    expect(isMiraeToolHiddenFor("avec_book", OTHER)).toBe(false);
    expect(isMiraeToolHiddenFor("crm_book_appointment", OTHER)).toBe(false);
  });
});
