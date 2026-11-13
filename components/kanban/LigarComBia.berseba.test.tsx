import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Berseba: "Ligar com a Bia" on the lead card (Berseba/berseba issue #232). Nothing where Voz is off
 * or the contact has no phone; two clicks to call; Voz's refusal comes back as the route's sentence.
 */
const toastError = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

import { LigarComBia } from "./LigarComBia";

const LEAD = "11111111-1111-4111-8111-111111111111";
const fetchMock = vi.fn();

function json(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

// No QueryClientProvider on purpose: the dossier mounts the button without one.
function montar(phone: string | null = "+5511987654321") {
  return render(<LigarComBia leadId={LEAD} phone={phone} />);
}

beforeEach(() => {
  fetchMock.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("LigarComBia", () => {
  it("draws nothing where Voz is off", async () => {
    fetchMock.mockImplementation(() => json(200, { data: { ativo: false } }));
    const { container } = montar();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("draws nothing when the check fails", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error("offline")));
    const { container } = montar();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    fetchMock.mockImplementation(() => json(500, {}));
    const second = montar();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(second.container).toBeEmptyDOMElement();
  });

  it("draws nothing without a phone", async () => {
    fetchMock.mockImplementation(() => json(200, { data: { ativo: true } }));
    const { container } = montar(" ");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("asks first, then calls with the lead's id", async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json(200, { data: { call_id: "c1" } })
        : json(200, { data: { ativo: true } }),
    );
    montar();
    const botao = await screen.findByRole("button", { name: /Ligar com a Bia/ });
    await userEvent.click(botao);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: /Confirmar: a Bia liga agora/ }));
    await screen.findByText("A Bia está ligando");
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ lead_id: LEAD });
    expect(toastSuccess).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /A Bia está ligando/ })).toBeDisabled();
  });

  it("cancel goes back without calling", async () => {
    fetchMock.mockImplementation(() => json(200, { data: { ativo: true } }));
    montar();
    await userEvent.click(await screen.findByRole("button", { name: /Ligar com a Bia/ }));
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.getByRole("button", { name: /Ligar com a Bia/ })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a refusal shows the route's sentence and the button comes back", async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json(409, { error: { message: "Este número pediu para não receber ligações." } })
        : json(200, { data: { ativo: true } }),
    );
    montar();
    await userEvent.click(await screen.findByRole("button", { name: /Ligar com a Bia/ }));
    await userEvent.click(screen.getByRole("button", { name: /Confirmar/ }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Este número pediu para não receber ligações."),
    );
    expect(screen.getByRole("button", { name: /Ligar com a Bia/ })).toBeEnabled();
  });
});
