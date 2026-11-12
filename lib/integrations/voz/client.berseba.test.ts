/** Berseba: the CRM asks Voz for a call (`POST /v1/calls`, Berseba/berseba issue #232). */
import { describe, expect, it, vi } from "vitest";

import { MENSAGEM_DO_PEDIDO, pedirLigacaoNaVoz } from "./client";

const CONFIG = { baseUrl: "https://voz.example", apiKey: "voz_abc123_secret", orgIds: new Set<string>() };
const LEAD = "11111111-1111-4111-8111-111111111111";

function answer(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("pedirLigacaoNaVoz", () => {
  it("sends the number, the agent and the lead, with the key", async () => {
    const fetchImpl = answer(202, { call_id: "c1" });
    expect(await pedirLigacaoNaVoz(CONFIG, { phone: "+5511987654321", leadId: LEAD }, fetchImpl)).toEqual({
      ok: true,
      callId: "c1",
    });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://voz.example/v1/calls");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer voz_abc123_secret" });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      to: "+5511987654321",
      agent: "bia",
      lead_ref: { connector: "crm-berseba", id: LEAD },
    });
  });

  it("turns Voz's refusals into codes", async () => {
    const cases: Array<[number, unknown, string]> = [
      [409, { error: "opted_out" }, "opted_out"],
      [409, { error: "in_progress" }, "in_progress"],
      [423, { error: "suspended" }, "suspended"],
      [429, { error: "daily_limit" }, "daily_limit"],
      [404, { error: "no_line" }, "no_line"],
      [400, { error: "bad_phone" }, "bad_phone"],
      [401, {}, "unauthorized"],
      [500, { error: "internal" }, "unavailable"],
      [202, {}, "unavailable"],
    ];
    for (const [status, body, codigo] of cases) {
      expect(await pedirLigacaoNaVoz(CONFIG, { phone: "1", leadId: LEAD }, answer(status, body))).toEqual({
        ok: false,
        codigo,
      });
    }
  });

  it("a network failure or a body that is not JSON is 'unavailable'", async () => {
    const down = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await pedirLigacaoNaVoz(CONFIG, { phone: "1", leadId: LEAD }, down)).toEqual({
      ok: false,
      codigo: "unavailable",
    });
    const html = vi.fn(async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch;
    expect((await pedirLigacaoNaVoz(CONFIG, { phone: "1", leadId: LEAD }, html)).ok).toBe(false);
  });

  it("every code has a sentence for the team", () => {
    for (const texto of Object.values(MENSAGEM_DO_PEDIDO)) expect(texto.length).toBeGreaterThan(10);
  });
});
