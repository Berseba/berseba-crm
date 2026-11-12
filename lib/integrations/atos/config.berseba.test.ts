import { describe, expect, it, vi } from "vitest";

const ORG = "546430cf-e857-4d2d-b1b6-5754390f8473";
const OTHER = "99999999-9999-4999-8999-999999999999";

vi.mock("@/lib/env", () => ({
  env: {
    ATOS_API_URL: "http://rbcor-atos-api:8000/",
    ATOS_API_KEY: "atos-test-key",
    ATOS_API_ORG_IDS: ` ${ORG.toUpperCase()} , not-a-uuid`,
  },
}));

const { atosConfigFor, isAtosToolHiddenFor, parseAtosConfig } = await import("./config");

const full = { url: "http://rbcor-atos-api:8000", key: "k", orgIds: ORG };

describe("parseAtosConfig", () => {
  it("is off unless URL, key and at least one organization are set", () => {
    expect(parseAtosConfig({})).toBeNull();
    expect(parseAtosConfig({ ...full, url: "" })).toBeNull();
    expect(parseAtosConfig({ ...full, url: "rbcor-atos-api:8000" })).toBeNull();
    expect(parseAtosConfig({ ...full, key: " " })).toBeNull();
    expect(parseAtosConfig({ ...full, orgIds: "nope" })).toBeNull();
    expect(parseAtosConfig(full)).toEqual({
      baseUrl: "http://rbcor-atos-api:8000",
      apiKey: "k",
      orgIds: new Set([ORG]),
    });
  });
});

describe("the install-level gate", () => {
  it("enables only the listed organization, and drops the trailing slash", () => {
    expect(atosConfigFor(ORG)?.baseUrl).toBe("http://rbcor-atos-api:8000");
    expect(atosConfigFor(ORG.toUpperCase())).not.toBeNull();
    expect(atosConfigFor(OTHER)).toBeNull();
  });

  it("hides only Atos tools, and only from other organizations", () => {
    expect(isAtosToolHiddenFor("atos_free_slots", OTHER)).toBe(true);
    expect(isAtosToolHiddenFor("atos_free_slots", ORG)).toBe(false);
    expect(isAtosToolHiddenFor("crm_search_contacts", OTHER)).toBe(false);
  });
});
