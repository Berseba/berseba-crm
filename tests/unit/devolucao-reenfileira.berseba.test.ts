import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const avisos = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: (...a: unknown[]) => avisos(...a), info: vi.fn(), debug: vi.fn() },
}));

import type { ConversaEmHandoff } from "@/lib/escalacao/devolucao-automatica";
import {
  IDADE_MAXIMA_DO_PENDENTE_MS,
  deveReenfileirarNaDevolucao,
  reenfileirarPendenteDaDevolucao,
} from "@/lib/escalacao/devolucao-reenfileira.berseba";

/**
 * Berseba (#58): the auto-return answers the client message that arrived while
 * the conversation was with a person. Sabotage: drop the call in
 * `app/api/v1/cron/handoff-devolucao/route.ts` and the client waits for the next
 * inbound (the limbo); drop the `inboundEmMs <= sinalHumanoMs` guard and the
 * "already handed off" case fails (the every-window handoff loop).
 */

const AGORA = new Date("2026-10-15T15:00:00.000Z");
const minAtras = (n: number) => AGORA.getTime() - n * 60_000;
const iso = (n: number) => new Date(minAtras(n)).toISOString();

describe("deveReenfileirarNaDevolucao", () => {
  const base = { agoraMs: AGORA.getTime() };

  it("the #58 case: client wrote after the handoff and nobody answered", () => {
    expect(
      deveReenfileirarNaDevolucao({ ...base, inboundEmMs: minAtras(3), outboundEmMs: minAtras(1500), sinalHumanoMs: minAtras(1500) }),
    ).toBe(true);
  });

  it("no inbound: nothing to answer", () => {
    expect(deveReenfileirarNaDevolucao({ ...base, inboundEmMs: null, outboundEmMs: null, sinalHumanoMs: null })).toBe(false);
  });

  it("already answered: an outbound came after the inbound", () => {
    expect(
      deveReenfileirarNaDevolucao({ ...base, inboundEmMs: minAtras(30), outboundEmMs: minAtras(10), sinalHumanoMs: minAtras(10) }),
    ).toBe(false);
  });

  it("the AI already handed off on that message: no loop", () => {
    // Inbound at -125 min, the AI handed off at -124 (its notice failed or was
    // not sent): the message is older than the human signal.
    expect(
      deveReenfileirarNaDevolucao({ ...base, inboundEmMs: minAtras(125), outboundEmMs: minAtras(300), sinalHumanoMs: minAtras(124) }),
    ).toBe(false);
  });

  it("older than 24 h: the first run after switching on does not answer last week", () => {
    const velho = AGORA.getTime() - IDADE_MAXIMA_DO_PENDENTE_MS - 60_000;
    expect(deveReenfileirarNaDevolucao({ ...base, inboundEmMs: velho, outboundEmMs: null, sinalHumanoMs: velho - 60_000 })).toBe(false);
  });

  it("no human stamp at all and no outbound: answers", () => {
    expect(deveReenfileirarNaDevolucao({ ...base, inboundEmMs: minAtras(5), outboundEmMs: null, sinalHumanoMs: null })).toBe(true);
  });
});

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const SESSAO = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";
const MSG = "55555555-5555-4555-8555-555555555555";

function conversa(over: Partial<ConversaEmHandoff> = {}): ConversaEmHandoff {
  return {
    id: CONV,
    organization_id: ORG,
    channel_session_id: SESSAO,
    status: "open",
    assignee_kind: null,
    assigned_to_user_id: null,
    assigned_at: null,
    bot_silenced_until: "infinity",
    last_handoff_at: iso(1500),
    last_outbound_at: iso(1500),
    status_changed_at: iso(1500),
    ...over,
  };
}

interface Linha {
  id: string;
  contact_id: string;
  created_at: string;
}

const ordensDoInbound: string[] = [];
const neqDoOutbound: string[] = [];

function dubleDoBanco(mensagens: { inbound: Linha | null; outbound: Linha | null }, erroDoRpc: string | null = null) {
  const rpc = vi.fn(async () => ({ data: null, error: erroDoRpc ? { message: erroDoRpc } : null }));
  const admin = {
    from: (tabela: string) => {
      if (tabela !== "messages") throw new Error(`unexpected table ${tabela}`);
      let direcao: "inbound" | "outbound" | null = null;
      const filtros: Record<string, unknown> = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal PostgREST chain double
      const chain: any = {
        select: () => chain,
        neq: (col: string, val: unknown) => {
          if (direcao === "outbound") neqDoOutbound.push(`${col}!=${String(val)}`);
          return chain;
        },
        eq: (col: string, val: unknown) => {
          filtros[col] = val;
          if (col === "direction") direcao = val as "inbound" | "outbound";
          return chain;
        },
        order: (col: string) => {
          if (direcao === "inbound") ordensDoInbound.push(col);
          return chain;
        },
        limit: async () => {
          expect(filtros.organization_id).toBe(ORG);
          expect(filtros.conversation_id).toBe(CONV);
          const linha = direcao ? mensagens[direcao] : null;
          return { data: linha ? [linha] : [], error: null };
        },
      };
      return chain;
    },
    rpc,
  };
  return { admin: admin as unknown as SupabaseClient, rpc };
}

beforeEach(() => {
  avisos.mockReset();
  ordensDoInbound.length = 0;
  neqDoOutbound.length = 0;
});

describe("reenfileirarPendenteDaDevolucao", () => {
  it("emits the ingestion's dispatch event for the pending inbound", async () => {
    const { admin, rpc } = dubleDoBanco({
      inbound: { id: MSG, contact_id: CONTATO, created_at: iso(3) },
      outbound: { id: "out", contact_id: CONTATO, created_at: iso(1500) },
    });
    expect(await reenfileirarPendenteDaDevolucao(admin, conversa(), "req-58", AGORA)).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "emit_event",
      expect.objectContaining({
        p_event_type: "ai_agent.dispatch_requested",
        p_entity_id: MSG,
        p_organization_id: ORG,
        p_payload: {
          organization_id: ORG,
          conversation_id: CONV,
          contact_id: CONTATO,
          channel_session_id: SESSAO,
          inbound_message_id: MSG,
        },
      }),
    );
  });

  it("picks the latest inbound with the drain's recency (sent_at first), or the drain drops the event", async () => {
    const { admin } = dubleDoBanco({ inbound: { id: MSG, contact_id: CONTATO, created_at: iso(3) }, outbound: null });
    await reenfileirarPendenteDaDevolucao(admin, conversa(), "req-58", AGORA);
    expect(ordensDoInbound).toEqual(["sent_at", "created_at"]);
  });

  it("a failed reply does not count as an answer", async () => {
    const { admin } = dubleDoBanco({ inbound: { id: MSG, contact_id: CONTATO, created_at: iso(3) }, outbound: null });
    await reenfileirarPendenteDaDevolucao(admin, conversa(), "req-58", AGORA);
    expect(neqDoOutbound).toEqual(["status!=failed"]);
  });

  it("nothing pending: no event", async () => {
    const { admin, rpc } = dubleDoBanco({
      inbound: { id: MSG, contact_id: CONTATO, created_at: iso(30) },
      outbound: { id: "out", contact_id: CONTATO, created_at: iso(10) },
    });
    expect(await reenfileirarPendenteDaDevolucao(admin, conversa({ last_outbound_at: iso(10) }), "req-58", AGORA)).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a failed emit never throws: the return already happened", async () => {
    const { admin } = dubleDoBanco(
      { inbound: { id: MSG, contact_id: CONTATO, created_at: iso(3) }, outbound: null },
      "boom",
    );
    await expect(reenfileirarPendenteDaDevolucao(admin, conversa(), "req-58", AGORA)).resolves.toBe(false);
    expect(avisos).toHaveBeenCalledTimes(1);
  });

  it("a conversation without a channel session is left alone", async () => {
    const { admin, rpc } = dubleDoBanco({ inbound: { id: MSG, contact_id: CONTATO, created_at: iso(3) }, outbound: null });
    expect(await reenfileirarPendenteDaDevolucao(admin, conversa({ channel_session_id: null }), "req-58", AGORA)).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("the cron wires it", () => {
  it("re-dispatches right after a successful return, with the row read before it", async () => {
    const { readFileSync } = await import("node:fs");
    const fonte = readFileSync("app/api/v1/cron/handoff-devolucao/route.ts", "utf8");
    expect(fonte).toMatch(
      /if \(r\.ok\) \{\s*devolvidas\+\+;[\s\S]{0,200}?await reenfileirarPendenteDaDevolucao\(admin, conversa, requestId, agora\);\s*continue;/,
    );
  });
});
