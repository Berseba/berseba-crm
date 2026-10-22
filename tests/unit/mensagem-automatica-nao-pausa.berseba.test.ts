/**
 * Berseba: a reminder another system sends from the business's own number does
 * not pause the AI; a person answering from the phone still does.
 *
 * Proved through the real `dispatchWahaEvent` with a mocked admin client, like
 * `waha-ingest-atendimento-manual.test.ts`. Sabotage: drop the
 * `ehMensagemAutomaticaDeOutroSistema` guard in `lib/waha/ingest.ts` and the
 * reminder case pauses the AI again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-teste",
  AI_GATEWAY_API_KEY: "",
  AI_GATEWAY_BASE_URL: "",
  OPENROUTER_API_KEY: "",
  OPENROUTER_BASE_URL: "",
  OPENAI_API_KEY: "",
};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}), isServiceRoleConfigured: () => false }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/channels/health", () => ({ sincronizarSaudeDaConexao: vi.fn(async () => {}) }));

import { dispatchWahaEvent } from "@/lib/waha/ingest";
import {
  casaComPadraoAutomatico,
  lerPadroesAutomaticos,
} from "@/lib/escalacao/mensagem-automatica.berseba";

const ORG = "org-1";
const SESSION = { id: "sess-1", organization_id: ORG, is_warmup_complete: true, warmup_started_at: null };
const PADROES = ["Estamos passando para lembrar", "lembramos de você"];

function makeAdmin(updates: Array<Record<string, unknown>>, settings: unknown) {
  const table = (name: string) => {
    let selectCols = "";
    let mode: "select" | "insert" | "update" = "select";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST chain double, as in the sibling test
    const chain: any = {
      select: (c?: string) => {
        selectCols = c ?? "";
        return chain;
      },
      insert: () => {
        mode = "insert";
        return chain;
      },
      update: (p: Record<string, unknown>) => {
        mode = "update";
        if (name === "conversations") updates.push(p);
        return chain;
      },
      eq: () => chain,
      in: () => chain,
      limit: () => chain,
      is: () => chain,
      gte: () => chain,
      order: () => chain,
      maybeSingle: () => {
        if (name === "organizations" && selectCols.includes("settings")) {
          return Promise.resolve({ data: { settings }, error: null });
        }
        if (name === "messages" && mode === "insert") {
          return Promise.resolve({ data: { id: "msg-nova" }, error: null });
        }
        if (name === "conversations" && selectCols.includes("bot_silenced_until")) {
          return Promise.resolve({ data: { bot_silenced_until: null }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then: (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(r),
    };
    return chain;
  };
  return {
    from: (n: string) => table(n),
    rpc: (fn: string) => {
      if (fn === "fn_upsert_wa_contact") return Promise.resolve({ data: "contact-1", error: null });
      if (fn === "fn_upsert_wa_conversation") return Promise.resolve({ data: "conv-1", error: null });
      return Promise.resolve({ data: null, error: null });
    },
  } as never;
}

function fromMe(id: string, body: string, type = "text") {
  return {
    event: "message.any",
    payload: { id, fromMe: true, to: "5511999999999@c.us", body, type, timestamp: Math.floor(Date.now() / 1000) },
  };
}

const pausou = (updates: Array<Record<string, unknown>>) =>
  updates.some((u) => u.last_handoff_reason !== undefined);

beforeEach(() => vi.clearAllMocks());

describe("automatic message from another system", () => {
  it("the return reminder does not pause the AI", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const lembrete =
      "Olá Ana, tudo bem? Estamos passando para lembrar, com carinho, que já chegou o momento ideal para realizar novamente o procedimento de CORTE FEMININO.";
    await dispatchWahaEvent(makeAdmin(updates, { automated_outbound_patterns: PADROES }), SESSION, fromMe("true_5511999999999@c.us_R1", lembrete, "document"), "req-1");
    expect(pausou(updates)).toBe(false);
  });

  it("a person replying from the phone still pauses it", async () => {
    const updates: Array<Record<string, unknown>> = [];
    await dispatchWahaEvent(makeAdmin(updates, { automated_outbound_patterns: PADROES }), SESSION, fromMe("true_5511999999999@c.us_R2", "Oi! Temos na terça às 9h30."), "req-2");
    expect(pausou(updates)).toBe(true);
  });

  it("without the setting, the reminder pauses as it always did", async () => {
    const updates: Array<Record<string, unknown>> = [];
    await dispatchWahaEvent(makeAdmin(updates, {}), SESSION, fromMe("true_5511999999999@c.us_R3", "Olá, Ana, lembramos de você..."), "req-3");
    expect(pausou(updates)).toBe(true);
  });
});

describe("pattern rules", () => {
  it("case and accent insensitive", () => {
    const p = lerPadroesAutomaticos({ automated_outbound_patterns: ["Lembramos de você"] });
    expect(casaComPadraoAutomatico("Olá, Gabriely, LEMBRAMOS DE VOCE... Por esse motivo", p)).toBe(true);
  });

  it("ignores short or non-string patterns, so a stray value never matches every reply", () => {
    expect(lerPadroesAutomaticos({ automated_outbound_patterns: ["ok", 3, null, "  "] })).toEqual([]);
    expect(lerPadroesAutomaticos({ automated_outbound_patterns: "lembramos de você" })).toEqual([]);
    expect(lerPadroesAutomaticos(null)).toEqual([]);
  });

  it("empty body never matches", () => {
    expect(casaComPadraoAutomatico(null, ["lembramos de voce"])).toBe(false);
    expect(casaComPadraoAutomatico("", ["lembramos de voce"])).toBe(false);
  });
});
