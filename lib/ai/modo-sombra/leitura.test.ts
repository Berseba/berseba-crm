import { describe, expect, it, vi } from "vitest";

import { lerModoSombra } from "./leitura";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";

describe("lerModoSombra — via pg.Pool", () => {
  it("lê os dois flags da mesma query", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ org_modo_sombra: true, canal_modo_sombra: false }],
    });
    const pool = { query } as never;

    const r = await lerModoSombra(pool, { organizationId: ORG, channelSessionId: CANAL });

    expect(r).toEqual({ org: true, canal: false });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("modo_sombra"), [ORG, CANAL]);
  });

  it("valor ausente (jsonb null) normaliza para false nos dois lados", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ org_modo_sombra: null, canal_modo_sombra: null }] });
    const pool = { query } as never;

    const r = await lerModoSombra(pool, { organizationId: ORG, channelSessionId: CANAL });

    expect(r).toEqual({ org: false, canal: false });
  });

  it("sem channelSessionId: consulta só a organização, canal falso", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ org_modo_sombra: true, canal_modo_sombra: null }] });
    const pool = { query } as never;

    const r = await lerModoSombra(pool, { organizationId: ORG });

    expect(r).toEqual({ org: true, canal: false });
    expect(query).toHaveBeenCalledWith(expect.any(String), [ORG, null]);
  });

  it("erro na query: propaga (fail-closed — o chamador decide não enviar)", async () => {
    const query = vi.fn().mockRejectedValue(new Error("connection reset"));
    const pool = { query } as never;

    await expect(
      lerModoSombra(pool, { organizationId: ORG, channelSessionId: CANAL }),
    ).rejects.toThrow("connection reset");
  });
});

describe("lerModoSombra — via SupabaseClient", () => {
  /** Dublê mínimo: `.from(tabela).select().eq().eq()?.maybeSingle()`. */
  function adminStub(respostas: {
    organizations: { data: unknown; error: { message: string } | null };
    channel_sessions?: { data: unknown; error: { message: string } | null };
  }) {
    const from = vi.fn((tabela: string) => {
      const resposta =
        tabela === "organizations" ? respostas.organizations : respostas.channel_sessions!;
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve(resposta),
      };
      return chain;
    });
    return { from } as never;
  }

  it("lê settings da organização e metadata do canal em paralelo", async () => {
    const admin = adminStub({
      organizations: { data: { settings: { modo_sombra: true } }, error: null },
      channel_sessions: { data: { metadata: { modo_sombra: false } }, error: null },
    });

    const r = await lerModoSombra(admin, { organizationId: ORG, channelSessionId: CANAL });

    expect(r).toEqual({ org: true, canal: false });
  });

  it("sem channelSessionId: não consulta channel_sessions, canal falso", async () => {
    const admin = adminStub({
      organizations: { data: { settings: { modo_sombra: false } }, error: null },
    });

    const r = await lerModoSombra(admin, { organizationId: ORG });

    expect(r).toEqual({ org: false, canal: false });
  });

  it("organização sem linha (data null): trata como false", async () => {
    const admin = adminStub({
      organizations: { data: null, error: null },
      channel_sessions: { data: null, error: null },
    });

    const r = await lerModoSombra(admin, { organizationId: ORG, channelSessionId: CANAL });

    expect(r).toEqual({ org: false, canal: false });
  });

  it("erro na leitura da organização: lança (fail-closed)", async () => {
    const admin = adminStub({
      organizations: { data: null, error: { message: "boom" } },
    });

    await expect(
      lerModoSombra(admin, { organizationId: ORG, channelSessionId: CANAL }),
    ).rejects.toThrow(/boom/);
  });

  it("erro na leitura do canal: lança (fail-closed)", async () => {
    const admin = adminStub({
      organizations: { data: { settings: {} }, error: null },
      channel_sessions: { data: null, error: { message: "canal indisponível" } },
    });

    await expect(
      lerModoSombra(admin, { organizationId: ORG, channelSessionId: CANAL }),
    ).rejects.toThrow(/canal indisponível/);
  });
});
