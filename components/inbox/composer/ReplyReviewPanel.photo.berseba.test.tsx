/**
 * The review panel shows the product photo an Assisted-mode draft carries
 * (Berseba, migration 9004), and does not let a caption over WhatsApp's limit be
 * approved.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReplyReviewPanel } from "./ReplyReviewPanel";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

const DRAFT = "dddddddd-0000-4000-8000-000000000001";

function draft(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT,
    revision: "2",
    status: "pending",
    original_body: "Olha as mechas morena!",
    edited_body: "Olha as mechas morena!",
    error_code: null,
    proposals: [],
    product_code: "mechas-morena",
    ...overrides,
  };
}

type Product = { code: string; name: string | null; has_photo: boolean; thumbnail_url: string | null };
const ACTIVE: Product = {
  code: "mechas-morena",
  name: "Mechas morena",
  has_photo: true,
  thumbnail_url: "https://storage.test/signed/capa.jpg",
};

function serve(d: ReturnType<typeof draft>, product: Product = ACTIVE) {
  api.get.mockImplementation(async (url: string) => {
    if (url.endsWith("/draft-reply")) return { data: { drafts: [d] } };
    if (url === `/api/v1/ai/replies/${DRAFT}/product`)
      return { data: { product } };
    throw new Error(`unexpected GET ${url}`);
  });
}

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ReplyReviewPanel conversationId="cccccccc-0000-4000-8000-000000000001" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
});

describe("ReplyReviewPanel — the product photo of an Assisted-mode draft", () => {
  it("shows the catalog thumbnail and says the photo goes with the reply", async () => {
    serve(draft());
    mount();
    const img = await screen.findByRole("img", { name: "Foto do produto" });
    expect(img).toHaveAttribute("src", "https://storage.test/signed/capa.jpg");
    expect(screen.getByText("Mechas morena")).toBeInTheDocument();
    expect(screen.getByText(/Aprovar envia a foto do produto com este texto como legenda/)).toBeInTheDocument();
  });

  it("approves with the edited text: the server sends it as the caption", async () => {
    serve(draft());
    api.post.mockResolvedValue({ data: { job_id: "job", status: "approved" } });
    mount();
    const box = await screen.findByLabelText("Resposta sugerida");
    fireEvent.change(box, { target: { value: "Texto editado pela atendente" } });
    fireEvent.click(screen.getByRole("button", { name: "Aprovar e enviar" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith(`/api/v1/ai/replies/${DRAFT}`, {
      action: "approve",
      revision: "2",
      body: "Texto editado pela atendente",
      feedback: "",
    });
  });

  it("refuses to approve a caption over 1,024 characters and says why", async () => {
    serve(draft());
    mount();
    const box = await screen.findByLabelText("Resposta sugerida");
    fireEvent.change(box, { target: { value: "a".repeat(1025) } });
    expect(screen.getByRole("alert")).toHaveTextContent(/até 1.024 caracteres/);
    expect(screen.getByRole("button", { name: "Aprovar e enviar" })).toBeDisabled();
  });

  it("a draft without a product asks for no thumbnail and keeps the text-only notice", async () => {
    serve(draft({ product_code: null }));
    mount();
    await screen.findByLabelText("Resposta sugerida");
    expect(screen.queryByTestId("reply-draft-product")).toBeNull();
    expect(screen.getByText(/Aprovar envia somente este texto/)).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalledWith(`/api/v1/ai/replies/${DRAFT}/product`);
  });

  it("a product deactivated since the draft blocks approval and says why", async () => {
    serve(draft(), { code: "mechas-morena", name: null, has_photo: false, thumbnail_url: null });
    mount();
    expect(
      await screen.findByText("Este produto não está mais ativo no catálogo. A resposta não será enviada."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aprovar e enviar" })).toBeDisabled();
  });

  it("a product without a photo says only the text goes", async () => {
    serve(draft(), { ...ACTIVE, has_photo: false, thumbnail_url: null });
    mount();
    expect(
      await screen.findByText("Este produto não tem foto no catálogo. Vai só o texto."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Aprovar envia somente este texto/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aprovar e enviar" })).toBeEnabled();
  });

  it("a send that failed for the product names the product, not the agent setup", async () => {
    serve(draft({ status: "failed", error_code: "product_not_found" }));
    mount();
    expect(
      await screen.findByText(
        "O produto desta sugestão não está mais ativo no catálogo. Nada foi enviado.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Confira a configuração do agente/)).toBeNull();
  });
});
