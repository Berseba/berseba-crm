/**
 * A bolha mostra, no fim do fio, o rascunho `pending`/`generating` que o
 * motor grava em `ai_reply_drafts` quando o agente está em modo assistido —
 * hoje isso só aparecia no `ReplyReviewPanel`, acima do composer. Este teste
 * prende a etiqueta ("não enviada" — nunca deixar parecer mensagem real), o
 * corpo, os 3 botões e a transição sem flicker ao decidir.
 *
 * Sem provider de idioma o `t()` degrada para a chave (pt-BR) — mesmo padrão
 * de MessageBubble.test.tsx.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (...args: unknown[]) => getMock(...args), post: (...args: unknown[]) => postMock(...args) },
}));

const showApiErrorMock = vi.fn();
vi.mock("@/components/feedback/ApiErrorToast", () => ({
  showApiError: (...args: unknown[]) => showApiErrorMock(...args),
}));

import { SuggestionBubble } from "./SuggestionBubble";

function draftDe(status: string, over: Record<string, unknown> = {}) {
  return {
    id: "d1",
    revision: "1",
    status,
    original_body: "Olá! Temos horário disponível amanhã às 10h.",
    edited_body: null,
    error_code: null,
    proposals: [],
    ...over,
  };
}

function renderBubble(onEditar = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SuggestionBubble conversationId="conv-1" onEditar={onEditar} />
    </QueryClientProvider>,
  );
  return { onEditar };
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  showApiErrorMock.mockReset();
});

describe("SuggestionBubble", () => {
  it("sem rascunho, não renderiza nada", async () => {
    getMock.mockResolvedValue({ data: { drafts: [] } });
    renderBubble();
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("status fora de pending/generating (ex.: já enviado) não renderiza — o Realtime já trouxe a mensagem real", async () => {
    getMock.mockResolvedValue({ data: { drafts: [draftDe("sent")] } });
    renderBubble();
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("pending: mostra etiqueta, corpo e os 3 botões", async () => {
    getMock.mockResolvedValue({ data: { drafts: [draftDe("pending")] } });
    renderBubble();

    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(screen.getByText("Sugestão da IA — não enviada")).toBeInTheDocument();
    expect(screen.getByText("Olá! Temos horário disponível amanhã às 10h.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aprovar e enviar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Editar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rejeitar" })).toBeInTheDocument();
  });

  it("edited_body vence original_body quando os dois existem", async () => {
    getMock.mockResolvedValue({
      data: { drafts: [draftDe("pending", { edited_body: "Versão editada pelo atendente" })] },
    });
    renderBubble();

    expect(await screen.findByText("Versão editada pelo atendente")).toBeInTheDocument();
    expect(screen.queryByText("Olá! Temos horário disponível amanhã às 10h.")).not.toBeInTheDocument();
  });

  it("generating: mostra esqueleto e nenhum botão de ação", async () => {
    getMock.mockResolvedValue({ data: { drafts: [draftDe("generating")] } });
    renderBubble();

    expect(await screen.findByText("Gerando sugestão…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aprovar e enviar" })).not.toBeInTheDocument();
  });

  it("Editar chama onEditar sem decidir nada (nenhum POST)", async () => {
    getMock.mockResolvedValue({ data: { drafts: [draftDe("pending")] } });
    const { onEditar } = renderBubble();

    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    expect(onEditar).toHaveBeenCalledTimes(1);
    expect(postMock).not.toHaveBeenCalled();
  });

  it("Aprovar e enviar chama fn_reply_action pela rota existente e a bolha some sem esperar o próximo poll", async () => {
    getMock.mockResolvedValue({ data: { drafts: [draftDe("pending")] } });
    postMock.mockResolvedValue({ data: { job_id: "j1", status: "approved" } });
    renderBubble();

    fireEvent.click(await screen.findByRole("button", { name: "Aprovar e enviar" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/v1/ai/replies/d1", {
        action: "approve",
        revision: "1",
        body: "Olá! Temos horário disponível amanhã às 10h.",
        feedback: undefined,
      }),
    );
    // Sem flicker: some assim que a decisão é tomada, sem esperar o refetch.
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("Rejeitar chama a mesma rota com action=reject e a bolha some", async () => {
    getMock.mockResolvedValue({ data: { drafts: [draftDe("pending")] } });
    postMock.mockResolvedValue({ data: { job_id: "j1", status: "dismissed" } });
    renderBubble();

    fireEvent.click(await screen.findByRole("button", { name: "Rejeitar" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        "/api/v1/ai/replies/d1",
        expect.objectContaining({ action: "reject" }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("decisão que falha traz a bolha de volta — o atendente pode tentar de novo", async () => {
    getMock.mockResolvedValue({ data: { drafts: [draftDe("pending")] } });
    postMock.mockRejectedValue(new Error("conflito"));
    renderBubble();

    fireEvent.click(await screen.findByRole("button", { name: "Aprovar e enviar" }));

    await waitFor(() => expect(showApiErrorMock).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Aprovar e enviar" })).toBeInTheDocument();
  });
});
