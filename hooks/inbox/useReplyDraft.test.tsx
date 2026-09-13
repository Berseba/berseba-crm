/**
 * `ReplyReviewPanel` (painel do composer) e `SuggestionBubble` (bolha no fim
 * do fio) leem o MESMO rascunho. Este arquivo prende duas coisas: que os dois
 * consumidores compartilham a MESMA queryKey — um só polling, não dois — e
 * que a decisão (aprovar/rejeitar) chama a rota existente (`fn_reply_action`
 * via `POST /api/v1/ai/replies/[id]`), nunca uma rota nova.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { apiClient } from "@/lib/api/client";
import {
  chaveDoRascunho,
  useDecideReplyDraft,
  useReplyDraft,
} from "./useReplyDraft";

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn() },
}));

function wrapperFor(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const draft = {
  id: "d1",
  revision: "3",
  status: "pending",
  original_body: "Olá! Temos horário amanhã às 10h.",
  edited_body: null,
  error_code: null,
  proposals: [],
};

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.post).mockReset();
});

describe("useReplyDraft", () => {
  it("expõe o primeiro rascunho da conversa", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { drafts: [draft] } } as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useReplyDraft("conv-1"), { wrapper: wrapperFor(qc) });

    await waitFor(() => expect(result.current.draft?.id).toBe("d1"));
    expect(apiClient.get).toHaveBeenCalledWith("/api/v1/conversations/conv-1/draft-reply");
  });

  it("conversationId nulo não dispara fetch — o polling desliga sem conversa selecionada", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useReplyDraft(null), { wrapper: wrapperFor(qc) });
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it("ReplyReviewPanel e SuggestionBubble montados juntos dividem a MESMA query — um só fetch, não dois", async () => {
    // A queryKey é o que faz o React Query tratar as duas montagens (painel do
    // composer + bolha do fio) como UMA query em cache: dois observers na
    // mesma chave compartilham o fetch em vez de cada um pollar sozinho.
    vi.mocked(apiClient.get).mockResolvedValue({ data: { drafts: [draft] } } as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    function DoisConsumidores() {
      const painel = useReplyDraft("conv-1");
      const bolha = useReplyDraft("conv-1");
      return (
        <>
          <span data-testid="painel">{painel.draft?.id}</span>
          <span data-testid="bolha">{bolha.draft?.id}</span>
        </>
      );
    }
    const { getByTestId } = render(<DoisConsumidores />, { wrapper: wrapperFor(qc) });

    await waitFor(() => expect(getByTestId("painel").textContent).toBe("d1"));
    expect(getByTestId("bolha").textContent).toBe("d1");
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });
});

describe("useDecideReplyDraft", () => {
  it("aprovar chama a rota existente com action/revision/body e invalida o cache do rascunho", async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { job_id: "j1", status: "approved" } } as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => useDecideReplyDraft("conv-1"), { wrapper: wrapperFor(qc) });
    await result.current.mutateAsync({
      draftId: "d1",
      revision: "3",
      action: "approve",
      body: "Olá! Temos horário amanhã às 10h.",
    });

    expect(apiClient.post).toHaveBeenCalledWith("/api/v1/ai/replies/d1", {
      action: "approve",
      revision: "3",
      body: "Olá! Temos horário amanhã às 10h.",
      feedback: undefined,
    });
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: chaveDoRascunho("conv-1") }),
    );
  });

  it("erro na decisão ainda invalida o cache — sem isso a bolha ficaria presa num estado velho", async () => {
    vi.mocked(apiClient.post).mockRejectedValue(new Error("conflito"));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => useDecideReplyDraft("conv-1"), { wrapper: wrapperFor(qc) });
    await expect(
      result.current.mutateAsync({ draftId: "d1", revision: "3", action: "reject" }),
    ).rejects.toThrow();

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: chaveDoRascunho("conv-1") }),
    );
  });
});
