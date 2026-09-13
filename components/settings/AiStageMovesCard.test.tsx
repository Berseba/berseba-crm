/**
 * Tela do seletor "Movimentação de etapa pela IA" (Configurações › Segurança).
 *
 * Não há um teste de TELA para modo-sombra ou nicho nesta branch (`git show
 * 05666b24 --stat` e `git show d868fa16 --stat` só trazem testes de ROTA e de
 * `lib/`) — o padrão mais próximo no repo para "tela de configuração que lê e
 * grava via apiClient" é `tests/unit/painel-de-seguranca.test.tsx`, e é o que
 * este arquivo segue: `apiClient` dublado, `QueryClientProvider` isolado, sem
 * subir a página inteira.
 *
 * A rota `/api/v1/settings/ai-stage-moves` não existe neste worktree (WP-A em
 * paralelo) — por isso `apiClient` é sempre mockado, nunca uma rota real
 * criada para o teste passar.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { apiClient } from "@/lib/api/client";
import { AiStageMovesCard } from "./AiStageMovesCard";

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), patch: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AiStageMovesCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.patch).mockReset();
});

describe("AiStageMovesCard", () => {
  it("duas opções, cada uma com rótulo e uma linha de explicação", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { mode: "auto" } } as never);
    renderCard();

    expect(screen.getByText("Automática")).toBeTruthy();
    expect(
      screen.getByText("o assistente move o negócio de etapa sozinho, conforme a conversa avança"),
    ).toBeTruthy();
    expect(screen.getByText("Sugerida")).toBeTruthy();
    expect(
      screen.getByText("o assistente sugere a etapa e uma pessoa confirma no funil"),
    ).toBeTruthy();
  });

  it("a nota sobre ganhou/perdido fica sempre visível", () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { mode: "auto" } } as never);
    renderCard();
    expect(
      screen.getByText("Ganhou e perdeu nunca são automáticos: são sempre sugeridos, em qualquer modo."),
    ).toBeTruthy();
  });

  it("reflete o modo que o servidor devolveu — a opção marcada é a que VALE hoje", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { mode: "suggest" } } as never);
    renderCard();

    await waitFor(() => {
      const sugerida = screen.getByRole("radio", { name: /Sugerida/i }) as HTMLInputElement;
      expect(sugerida.checked).toBe(true);
    });
    const automatica = screen.getByRole("radio", { name: /Automática/i }) as HTMLInputElement;
    expect(automatica.checked).toBe(false);
  });

  it("escolher a outra opção chama PATCH com o novo modo", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { mode: "auto" } } as never);
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { mode: "suggest" } } as never);
    renderCard();

    await waitFor(() => {
      const automatica = screen.getByRole("radio", { name: /Automática/i }) as HTMLInputElement;
      expect(automatica.checked).toBe(true);
    });

    fireEvent.click(screen.getByRole("radio", { name: /Sugerida/i }));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith("/api/v1/settings/ai-stage-moves", {
        mode: "suggest",
      }),
    );
  });
});
