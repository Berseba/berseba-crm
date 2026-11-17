/** Berseba: Voz's install-level gate. Fails closed. */
import { describe, expect, it } from "vitest";

import { parseVozConfig } from "./config";

const ORG = "0cc6e9e0-a9b0-42a4-951b-a0cb1e554a48";

describe("parseVozConfig", () => {
  it("reads the three values", () => {
    expect(
      parseVozConfig({
        url: "https://voz.grupoberseba.com.br/",
        key: " voz_abc123_x ",
        orgIds: ` ${ORG.toUpperCase()} , junk`,
      }),
    ).toEqual({
      baseUrl: "https://voz.grupoberseba.com.br",
      apiKey: "voz_abc123_x",
      orgIds: new Set([ORG]),
    });
  });

  it("tolerates a pasted /v1 or /v1/calls tail", () => {
    for (const url of ["https://voz.example/v1", "https://voz.example/v1/calls"]) {
      expect(parseVozConfig({ url, key: "voz_k", orgIds: ORG })?.baseUrl).toBe(
        "https://voz.example",
      );
    }
  });

  it("is off when any value is missing or malformed", () => {
    expect(parseVozConfig({})).toBeNull();
    expect(parseVozConfig({ url: "voz.example", key: "voz_k", orgIds: ORG })).toBeNull();
    expect(
      parseVozConfig({ url: "https://voz.example/a/b", key: "voz_k", orgIds: ORG }),
    ).toBeNull();
    expect(parseVozConfig({ url: "https://voz.example", key: "dsk_k", orgIds: ORG })).toBeNull();
    expect(
      parseVozConfig({ url: "https://voz.example", key: "voz_k", orgIds: "not-a-uuid" }),
    ).toBeNull();
    // One key and one webhook token belong to one organization: two would mix their reports.
    expect(
      parseVozConfig({
        url: "https://voz.example",
        key: "voz_k",
        orgIds: `${ORG},4212479e-2b5a-4949-807e-706b2fce16fe`,
      }),
    ).toBeNull();
  });
});
