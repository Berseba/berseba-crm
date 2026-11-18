import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterTouch } from "./RegisterTouch";

/**
 * "Registrar toque" (Berseba, migration 9005), clicked the way a person would:
 * open, pick a channel, type a note, save. What is measured is what leaves the
 * browser (the POST body) and what the screen does after (the form closes, the
 * timeline query is invalidated, an error keeps the form open).
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const LEAD = "11111111-1111-4111-8111-111111111111";

function renderIt(canRegister = true) {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <RegisterTouch leadId={LEAD} canRegister={canRegister} />
    </QueryClientProvider>,
  );
  return { invalidate };
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("RegisterTouch", () => {
  it("draws nothing below `agent`", () => {
    renderIt(false);
    expect(screen.queryByRole("button", { name: "Registrar toque" })).toBeNull();
  });

  it("opens, needs a channel, and posts channel and note to the lead's route", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { channel: "linkedin" } }), { status: 201 }));
    const { invalidate } = renderIt();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Registrar toque" }));
    const save = screen.getByRole("button", { name: "Salvar toque" });
    expect(save).toBeDisabled();

    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual([
      "E-mail",
      "LinkedIn",
      "WhatsApp",
      "Telefonema",
    ]);
    await user.click(screen.getByRole("radio", { name: "LinkedIn" }));
    expect(screen.getByRole("radio", { name: "LinkedIn" })).toHaveAttribute("aria-checked", "true");
    await user.type(screen.getByLabelText("Anotação (opcional)"), "  Mandei convite  ");
    await user.click(save);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/v1/leads/${LEAD}/touches`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ channel: "linkedin", note: "Mandei convite" });

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Toque registrado."));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["timeline", LEAD] });
    // The form closed: the button is back.
    expect(screen.getByRole("button", { name: "Registrar toque" })).toBeInTheDocument();
  });

  it("an empty note is not sent", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 201 }));
    renderIt();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Registrar toque" }));
    await user.click(screen.getByRole("radio", { name: "Telefonema" }));
    await user.click(screen.getByRole("button", { name: "Salvar toque" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ channel: "call" });
  });

  it("a refused save shows the server's message and keeps what was typed", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "not_found", message: "Lead não encontrado." } }), { status: 404 }),
    );
    renderIt();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Registrar toque" }));
    await user.click(screen.getByRole("radio", { name: "E-mail" }));
    await user.type(screen.getByLabelText("Anotação (opcional)"), "Proposta");
    await user.click(screen.getByRole("button", { name: "Salvar toque" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Lead não encontrado."));
    expect(screen.getByLabelText("Anotação (opcional)")).toHaveValue("Proposta");
    expect(screen.getByRole("button", { name: "Salvar toque" })).toBeEnabled();
  });
});
