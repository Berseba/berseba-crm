import { describe, expect, it, vi } from "vitest";

const ORG = "0cc6e9e0-a9b0-42a4-951b-a0cb1e554a48";
const OTHER = "99999999-9999-4999-8999-999999999999";
const URL_OK = "https://jo.example.supabase.co/functions/v1/crm-agenda-avaliacao";

vi.mock("@/lib/env", () => ({
  env: {
    JOOS_AGENDA_URL: `${URL_OK}/`,
    JOOS_AGENDA_SECRET: "segredo-de-teste",
    JOOS_AGENDA_ORG_IDS: ` ${ORG.toUpperCase()} , not-a-uuid`,
  },
}));

const { isJoOsToolHiddenFor, joOsConfigFor, parseJoOsConfig } = await import("./config");

const full = { url: URL_OK, secret: "s", orgIds: ORG };

describe("parseJoOsConfig", () => {
  it("is off unless URL, secret and at least one organization are set", () => {
    expect(parseJoOsConfig({})).toBeNull();
    expect(parseJoOsConfig({ ...full, url: "" })).toBeNull();
    expect(parseJoOsConfig({ ...full, url: "jo.example/functions/v1/x" })).toBeNull();
    expect(parseJoOsConfig({ ...full, url: "http://jo.example/functions/v1/x" })).toBeNull();
    expect(parseJoOsConfig({ ...full, url: "https://jo.example" })).toBeNull();
    expect(parseJoOsConfig({ ...full, secret: " " })).toBeNull();
    expect(parseJoOsConfig({ ...full, orgIds: "nope" })).toBeNull();
  });

  it("keeps only valid organization ids, lowercased, and drops a trailing slash", () => {
    const c = parseJoOsConfig({ ...full, url: `${URL_OK}//`, orgIds: `${ORG.toUpperCase()},bad` });
    expect(c?.orgIds).toEqual(new Set([ORG]));
    expect(c?.url).toBe(URL_OK);
  });
});

describe("the install-level gate", () => {
  it("enables only the listed organization", () => {
    expect(joOsConfigFor(ORG)?.url).toBe(URL_OK);
    expect(joOsConfigFor(OTHER)).toBeNull();
  });

  it("hides only Jo OS tools, and only from other organizations", () => {
    expect(isJoOsToolHiddenFor("joos_evaluation_slots", OTHER)).toBe(true);
    expect(isJoOsToolHiddenFor("joos_evaluation_slots", ORG)).toBe(false);
    expect(isJoOsToolHiddenFor("mirae_free_slots", OTHER)).toBe(false);
    expect(isJoOsToolHiddenFor("crm_find_free_slots", OTHER)).toBe(false);
  });
});
