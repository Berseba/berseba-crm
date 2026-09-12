/**
 * O worker LEGADO (`workers/ai-response-worker.ts`) TAMBÉM respeita o modo
 * sombra — o cinto de segurança acima do agente, por organização ou canal.
 *
 * Achado ao mapear os pontos de envio (relatório da feature): este caminho
 * está PERMANENTEMENTE desligado para enviar de qualquer forma —
 * `elegivelParaWorkerLegado` (`lib/ai/agents/no-ar.ts`) devolve `false`
 * incondicionalmente, então `processMessageReceived` sempre skips
 * `agent_inactive_or_missing` antes de chamar o LLM ou inserir a outbound. O
 * gate de modo sombra deste arquivo é defesa em profundidade — se aquela trava
 * for reaberta um dia, esta continua de pé — e é isso que o teste prova: com
 * o modo sombra ligado, o skip acontece por `modo_sombra`, ANTES mesmo daquele
 * outro motivo, na mesma posição que os demais gates de segurança do arquivo
 * (elegibilidade, handoff).
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
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/ai/gateway", () => ({
  DEFAULT_BOT_MODEL: "anthropic/claude-sonnet-4-6",
  gatewayConfig: {},
  gatewayHeaders: () => ({}),
  isAiGatewayConfigured: () => true,
  isEmbeddingProviderConfigured: () => false,
}));

const { lerModoSombra } = vi.hoisted(() => ({
  lerModoSombra: vi.fn(async () => ({ org: false, canal: false })),
}));
vi.mock("@/lib/ai/modo-sombra", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  lerModoSombra,
}));

import { processMessageReceived } from "@/workers/ai-response-worker";
import { createAdminClient } from "@/lib/supabase/admin";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "44444444-4444-4444-8444-444444444444";
const MSG_ID = "55555555-5555-4555-8555-555555555555";
const CONTACT_ID = "66666666-6666-4666-8666-666666666666";
const CHANNEL_ID = "77777777-7777-4777-8777-777777777777";
const AGENT_ID = "88888888-8888-4888-8888-888888888888";

/** Stub genérico: qualquer tabela não listada devolve linha vazia/nula. */
function makeAdminStub() {
  const from = (table: string) => {
    const single: Record<string, unknown> | null =
      table === "conversations"
        ? {
            id: CONV_ID,
            organization_id: ORG_ID,
            contact_id: CONTACT_ID,
            channel_session_id: CHANNEL_ID,
            last_inbound_at: new Date().toISOString(),
            bot_silenced_until: null,
            last_handoff_at: null,
            assignee_kind: "ai",
            contacts: {
              id: CONTACT_ID,
              display_name: null,
              locale: "pt-BR",
              is_blocked: false,
              force_human: false,
              ai_authorized_at: null,
            },
            channel_sessions: { metadata: {} },
          }
        : table === "messages"
          ? { id: MSG_ID, body: "bom dia", direction: "inbound", organization_id: ORG_ID }
          : table === "ai_agents"
            ? {
                id: AGENT_ID,
                organization_id: ORG_ID,
                model: "anthropic/claude-sonnet-4-6",
                system_prompt: "Você é um atendente.",
                config: {},
                guardrails: {},
                active_kb_version_id: null,
                is_active: true,
                is_default: true,
                kind: "rag_bot",
                published_version_id: null,
                archived_at: null,
                paused_at: null,
                operation_mode: "automatic",
              }
            : null;

    let consultaDePublicado = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const terminais: any = {
      maybeSingle: () =>
        Promise.resolve({ data: consultaDePublicado ? null : single, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: table === "ai_agents" ? (single ? [single] : []) : single ? [single] : [],
          error: null,
        }).then(resolve),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = new Proxy(terminais, {
      get: (alvo, prop) =>
        prop in alvo
          ? alvo[prop as keyof typeof alvo]
          : (...args: unknown[]) => {
              if (prop === "not" && args[0] === "published_version_id") consultaDePublicado = true;
              return chain;
            },
    });
    return chain;
  };
  return { from } as never;
}

const eventRow = {
  organization_id: ORG_ID,
  entity_id: MSG_ID,
  payload: { message_id: MSG_ID, conversation_id: CONV_ID },
} as unknown as EventRow;

beforeEach(() => {
  vi.clearAllMocks();
  lerModoSombra.mockResolvedValue({ org: false, canal: false });
  vi.mocked(createAdminClient).mockReturnValue(makeAdminStub());
});

describe("ai-response-worker (legado) · modo sombra", () => {
  it("organização em sombra → skip 'modo_sombra'", async () => {
    lerModoSombra.mockResolvedValue({ org: true, canal: false });
    const result = await processMessageReceived(eventRow);
    expect(result).toMatchObject({ status: "skipped", reason: "modo_sombra" });
  });

  it("canal em sombra → skip 'modo_sombra'", async () => {
    lerModoSombra.mockResolvedValue({ org: false, canal: true });
    const result = await processMessageReceived(eventRow);
    expect(result).toMatchObject({ status: "skipped", reason: "modo_sombra" });
  });

  it("nem org nem canal em sombra → o gate não dispara (motivo != 'modo_sombra')", async () => {
    lerModoSombra.mockResolvedValue({ org: false, canal: false });
    const result = await processMessageReceived(eventRow);
    expect(result.reason).not.toBe("modo_sombra");
  });

  it("leitura do modo sombra falha → skip 'modo_sombra' (fail-closed)", async () => {
    lerModoSombra.mockRejectedValue(new Error("connection reset"));
    const result = await processMessageReceived(eventRow);
    expect(result).toMatchObject({ status: "skipped", reason: "modo_sombra" });
  });

  it("consulta recebe o canal da conversa lida", async () => {
    await processMessageReceived(eventRow);
    expect(lerModoSombra).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: ORG_ID, channelSessionId: CHANNEL_ID }),
    );
  });
});
