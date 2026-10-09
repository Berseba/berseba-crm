import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as PanelModule from "@/components/inbox/composer/ReplyReviewPanel";

/**
 * Berseba: the reply suggestion panel can be collapsed to a single line, so the
 * conversation history stays readable while a suggestion waits for review. The
 * choice is remembered per browser.
 */

const get = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({ apiClient: { get, post: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

let ReplyReviewPanel: typeof PanelModule.ReplyReviewPanel;

const KEY = "berseba.reply_review.collapsed";
const SUGGESTION = "Olá! Aqui é a Maya, atendente virtual do salão.";

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ReplyReviewPanel conversationId="conv-1" />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  window.localStorage.clear();
  // Fresh module per case: the collapsed preference also lives in module memory.
  vi.resetModules();
  ({ ReplyReviewPanel } = await import("@/components/inbox/composer/ReplyReviewPanel"));
  get.mockReset().mockResolvedValue({
    data: {
      drafts: [
        {
          id: "d1",
          revision: "r1",
          status: "pending",
          original_body: SUGGESTION,
          edited_body: null,
          error_code: null,
          proposals: [],
        },
      ],
    },
  });
});

describe("ReplyReviewPanel collapse (Berseba)", () => {
  it("starts expanded and collapses to a one-line preview", async () => {
    renderPanel();
    expect(await screen.findByLabelText("Resposta sugerida")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Recolher sugestão" }));

    expect(screen.queryByLabelText("Resposta sugerida")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aprovar e enviar" })).not.toBeInTheDocument();
    // The status and a preview stay visible: a pending suggestion is never hidden.
    expect(screen.getByText("Sugestão para revisar")).toBeInTheDocument();
    expect(screen.getByText(SUGGESTION)).toBeInTheDocument();
    expect(window.localStorage.getItem(KEY)).toBe("1");
  });

  it("remembers the collapsed choice and expands from the preview", async () => {
    window.localStorage.setItem(KEY, "1");
    renderPanel();
    const preview = await screen.findByText(SUGGESTION);
    expect(screen.queryByLabelText("Resposta sugerida")).not.toBeInTheDocument();

    fireEvent.click(preview);

    await waitFor(() => expect(screen.getByLabelText("Resposta sugerida")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Recolher sugestão" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(window.localStorage.getItem(KEY)).toBe("0");
  });
});
