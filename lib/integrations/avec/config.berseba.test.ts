import { describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";

vi.mock("@/lib/env", () => ({
  env: {
    AVEC_API_URL: "http://mayara-avec-api:8000/",
    AVEC_API_KEY: "k",
    AVEC_API_ORG_IDS: ` ${ORG.toUpperCase()} , not-a-uuid`,
  },
}));

const { avecConfigFor, isAvecToolHiddenFor, parseAvecConfig } = await import("./config");

describe("parseAvecConfig", () => {
  it("is off unless URL, key and at least one organization are set", () => {
    expect(parseAvecConfig({})).toBeNull();
    expect(parseAvecConfig({ url: "http://x:8000", key: "k" })).toBeNull();
    expect(parseAvecConfig({ url: "http://x:8000", orgIds: ORG })).toBeNull();
    expect(parseAvecConfig({ url: "mayara-avec-api:8000", key: "k", orgIds: ORG })).toBeNull();
    expect(parseAvecConfig({ url: "http://x:8000", key: "k", orgIds: "nope" })).toBeNull();
  });

  it("trims the trailing slash and keeps only valid organization ids, lowercased", () => {
    const config = parseAvecConfig({
      url: " http://x:8000/ ",
      key: " k ",
      orgIds: `${ORG.toUpperCase()},bad`,
    });
    expect(config).toEqual({ baseUrl: "http://x:8000", apiKey: "k", orgIds: new Set([ORG]) });
  });
});

describe("the install-level gate", () => {
  it("enables only the listed organization", () => {
    expect(avecConfigFor(ORG)?.baseUrl).toBe("http://mayara-avec-api:8000");
    expect(avecConfigFor("99999999-9999-4999-8999-999999999999")).toBeNull();
  });

  it("hides only avec tools, and only from other organizations", () => {
    expect(isAvecToolHiddenFor("avec_cancel", "99999999-9999-4999-8999-999999999999")).toBe(true);
    expect(isAvecToolHiddenFor("avec_cancel", ORG)).toBe(false);
    expect(
      isAvecToolHiddenFor("crm_cancel_appointment", "99999999-9999-4999-8999-999999999999"),
    ).toBe(false);
  });
});
