/**
 * O chip da sugestão de etapa — mesmo padrão de mock de `apiClient` de
 * `hooks/inbox/useReplyDraft.test.tsx`: mede o COMPONENTE, não a rede. As
 * rotas de apply/reject não existem neste worktree (WP-A entrega em
 * paralelo), então nada aqui bate numa rota real.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { apiClient } from "@/lib/api/client";
import { StageSuggestionChip } from "./StageSuggestionChip";

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn() },
}));

function renderChip() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <StageSuggestionChip
        leadId="lead-1"
        suggestionId="sug-1"
        toStageName="Negociação"
        pipelineId="pipe-1"
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(apiClient.post).mockReset();
});

describe("StageSuggestionChip", () => {
  it("mostra o texto com a etapa de destino e os dois botões", () => {
    renderChip();
    // "IA sugere: Negociação" chega em nós de texto separados
    // ("IA sugere:", " ", "Negociação") — casa pelo `title`, que carrega a
    // frase inteira, em vez de fatiar o texto visível.
    expect(screen.getByTitle("IA sugere: Negociação")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Aplicar sugestão/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Recusar sugestão/i })).toBeTruthy();
  });

  it("Aplicar chama a rota de apply com o leadId e o suggestionId do chip", async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: {} } as never);
    renderChip();

    fireEvent.click(screen.getByRole("button", { name: /Aplicar sugestão/i }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith(
        "/api/v1/leads/lead-1/stage-suggestion/sug-1/apply",
        {},
      ),
    );
  });

  it("Recusar chama a rota de reject", async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: {} } as never);
    renderChip();

    fireEvent.click(screen.getByRole("button", { name: /Recusar sugestão/i }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith(
        "/api/v1/leads/lead-1/stage-suggestion/sug-1/reject",
        {},
      ),
    );
  });

  it("clicar nos botões não propaga o clique para um wrapper externo (o card seleciona/abre no clique)", () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: {} } as never);
    const onWrapperClick = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <div onClick={onWrapperClick}>
          <StageSuggestionChip
            leadId="lead-1"
            suggestionId="sug-1"
            toStageName="Negociação"
            pipelineId="pipe-1"
          />
        </div>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Aplicar sugestão/i }));
    expect(onWrapperClick).not.toHaveBeenCalled();
  });
});
