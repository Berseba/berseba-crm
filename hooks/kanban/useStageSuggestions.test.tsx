/**
 * Padrão de `hooks/inbox/useReplyDraft.test.tsx`: `apiClient` é dublado (o
 * teste mede a TELA/hook, não a rede), e `useRealtimeChannel` também — este
 * hook assina o canal de `crm_leads` só para invalidar mais cedo que o
 * polling de 5s, e a assinatura de verdade pertence ao teste de
 * `useRealtimeChannel`, não a este arquivo.
 *
 * Enquanto o WP-A não existe neste worktree, as rotas
 * `/api/v1/pipelines/[id]/stage-suggestions` e
 * `/api/v1/leads/[id]/stage-suggestion/[id]/{apply,reject}` não existem de
 * verdade — por isso todo o `apiClient` é mockado, nunca uma rota real criada.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";

const mocks = vi.hoisted(() => ({ realtime: vi.fn(() => ({ status: "subscribed", ultimaEntrega: { current: null } })) }));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({ useRealtimeChannel: mocks.realtime }));

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn() },
}));

import { useDecidirSugestaoDeEtapa, useStageSuggestions } from "./useStageSuggestions";

function wrapperFor(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const sugestao = {
  id: "sug-1",
  lead_id: "lead-1",
  from_stage_id: "stage-1",
  to_stage_id: "stage-2",
  to_stage_name: "Negociação",
  reason: "Cliente confirmou orçamento",
  source: "agent",
  created_at: "2026-09-01T12:00:00Z",
};

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.post).mockReset();
  mocks.realtime.mockClear();
});

describe("useStageSuggestions", () => {
  it("busca a lista de sugestões pendentes do pipeline", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { suggestions: [sugestao] } } as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useStageSuggestions("pipe-1"), { wrapper: wrapperFor(qc) });

    await waitFor(() => expect(result.current.data).toEqual([sugestao]));
    expect(apiClient.get).toHaveBeenCalledWith("/api/v1/pipelines/pipe-1/stage-suggestions");
  });

  it("pipelineId nulo não dispara fetch", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useStageSuggestions(null), { wrapper: wrapperFor(qc) });
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it("ouve o canal de crm_leads do pipeline para invalidar mais cedo que o polling", () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { suggestions: [] } } as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useStageSuggestions("pipe-1"), { wrapper: wrapperFor(qc) });

    expect(mocks.realtime).toHaveBeenCalledWith(
      expect.objectContaining({
        postgresChanges: expect.objectContaining({
          table: "crm_leads",
          filter: "pipeline_id=eq.pipe-1",
        }),
      }),
    );
  });
});

describe("useDecidirSugestaoDeEtapa", () => {
  it("aplicar chama a rota de apply e invalida board + sugestões + a do lead", async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { lead: {}, suggestion: {} } } as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => useDecidirSugestaoDeEtapa("pipe-1"), {
      wrapper: wrapperFor(qc),
    });
    await result.current.mutateAsync({ leadId: "lead-1", suggestionId: "sug-1", decision: "apply" });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/api/v1/leads/lead-1/stage-suggestion/sug-1/apply",
      {},
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["stage-suggestions", "pipe-1"] }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["board", "pipe-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["lead-stage-suggestion", "lead-1"] });
  });

  it("recusar chama a rota de reject", async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { suggestion: {} } } as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useDecidirSugestaoDeEtapa("pipe-1"), {
      wrapper: wrapperFor(qc),
    });
    await result.current.mutateAsync({ leadId: "lead-1", suggestionId: "sug-1", decision: "reject" });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/api/v1/leads/lead-1/stage-suggestion/sug-1/reject",
      {},
    );
  });

  it("409 (alguém já decidiu) ainda invalida — o card precisa mostrar o estado real", async () => {
    vi.mocked(apiClient.post).mockRejectedValue(
      new ApiError(409, "stage_suggestion_not_pending", undefined, "req-1", "Alguém já decidiu esta sugestão."),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => useDecidirSugestaoDeEtapa("pipe-1"), {
      wrapper: wrapperFor(qc),
    });
    await expect(
      result.current.mutateAsync({ leadId: "lead-1", suggestionId: "sug-1", decision: "apply" }),
    ).rejects.toThrow();

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["board", "pipe-1"] }),
    );
  });
});
