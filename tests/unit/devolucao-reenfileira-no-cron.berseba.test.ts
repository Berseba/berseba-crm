import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Berseba (#58): the real `devolverHandoffsVencidos` hands each returned
 * conversation to the re-dispatch, with the row it read BEFORE the return (the
 * return clears the human-signal stamps the rule needs). A conversation whose
 * return failed is not re-dispatched.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const SESSAO = "33333333-3333-4333-8333-333333333333";
const VOLTOU = "44444444-4444-4444-8444-444444444444";
const FALHOU = "55555555-5555-4555-8555-555555555555";
const AGORA = new Date("2026-10-15T15:00:00.000Z");
const minAtras = (n: number) => new Date(AGORA.getTime() - n * 60_000).toISOString();

const devolver = vi.fn();
const reenfileirar = vi.fn(async () => true);

vi.mock("@/lib/env", () => ({ env: { INTERNAL_CRON_SECRET: "x", INTERNAL_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/escalacao/retomada", () => ({ devolverAtendimentoAoAgente: (...a: unknown[]) => devolver(...a) }));
vi.mock("@/lib/escalacao/devolucao-reenfileira.berseba", () => ({
  reenfileirarPendenteDaDevolucao: (...a: unknown[]) => reenfileirar(...(a as [])),
}));

import { devolverHandoffsVencidos } from "@/app/api/v1/cron/handoff-devolucao/route";

function conversa(id: string) {
  return {
    id,
    organization_id: ORG,
    channel_session_id: SESSAO,
    status: "open",
    assignee_kind: null,
    assigned_to_user_id: null,
    assigned_at: null,
    bot_silenced_until: "infinity",
    last_handoff_at: minAtras(300),
    last_outbound_at: minAtras(300),
    status_changed_at: minAtras(300),
  };
}

const tabelas: Record<string, unknown[]> = {
  organizations: [{ id: ORG, settings: { routing: { handoff_return_after_minutes: 120 } } }],
  conversations: [conversa(VOLTOU), conversa(FALHOU)],
  ai_agents: [{ organization_id: ORG, ai_agent_versions: { channel_session_id: SESSAO, status: "published" } }],
  ai_routers: [],
};

function admin() {
  return {
    from: (tabela: string) => {
      const resultado = () => Promise.resolve({ data: tabelas[tabela] ?? [], error: null });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST chain double; filters are the pure rule's job
      const chain: any = {
        select: () => chain,
        not: () => chain,
        in: () => chain,
        is: () => chain,
        eq: () => chain,
        or: () => chain,
        limit: () => resultado(),
        then: (r: (v: unknown) => unknown) => resultado().then(r),
      };
      return chain;
    },
  } as never;
}

beforeEach(() => {
  devolver.mockReset();
  reenfileirar.mockClear();
  devolver.mockImplementation(async (_deps: unknown, input: { conversationId: string }) =>
    input.conversationId === VOLTOU ? { ok: true } : { ok: false, erro: "assignment_conflict" },
  );
});

describe("the cron hands returned conversations to the re-dispatch", () => {
  it("re-dispatches the returned one, with the row read before the return", async () => {
    const r = await devolverHandoffsVencidos(admin(), "req-58", AGORA);
    expect(r.devolvidas).toBe(1);
    expect(reenfileirar).toHaveBeenCalledTimes(1);
    const [, linha, requestId, agora] = reenfileirar.mock.calls[0] as unknown as [unknown, { id: string; last_handoff_at: string }, string, Date];
    expect(linha.id).toBe(VOLTOU);
    expect(linha.last_handoff_at).toBe(minAtras(300));
    expect(requestId).toBe("req-58");
    expect(agora).toBe(AGORA);
  });

  it("never re-dispatches a conversation whose return failed", async () => {
    await devolverHandoffsVencidos(admin(), "req-58", AGORA);
    const ids = reenfileirar.mock.calls.map((c) => (c as unknown as [unknown, { id: string }])[1].id);
    expect(ids).not.toContain(FALHOU);
  });
});
