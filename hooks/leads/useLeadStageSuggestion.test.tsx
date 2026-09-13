/**
 * Padrão de `hooks/inbox/useReplyDraft.test.tsx`: `apiClient` dublado, mede o
 * hook. A rota `/api/v1/leads/[id]/stage-suggestion` não existe neste
 * worktree (WP-A em paralelo).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { apiClient } from "@/lib/api/client";
import { useLeadStageSuggestion } from "./useLeadStageSuggestion";

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn() },
}));

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
  reason: null,
  source: "agent",
  created_at: "2026-09-01T12:00:00Z",
};

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
});

describe("useLeadStageSuggestion", () => {
  it("expõe a sugestão pendente deste lead", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { suggestion: sugestao } } as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useLeadStageSuggestion("lead-1"), {
      wrapper: wrapperFor(qc),
    });

    await waitFor(() => expect(result.current.data).toEqual(sugestao));
    expect(apiClient.get).toHaveBeenCalledWith("/api/v1/leads/lead-1/stage-suggestion");
  });

  it("sem sugestão, devolve null em vez de undefined indefinido", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { suggestion: null } } as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useLeadStageSuggestion("lead-1"), {
      wrapper: wrapperFor(qc),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("leadId nulo não dispara fetch — dossiê fechado não pola", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useLeadStageSuggestion(null), { wrapper: wrapperFor(qc) });
    expect(apiClient.get).not.toHaveBeenCalled();
  });
});
