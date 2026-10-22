/**
 * Berseba: the login screen when the email was never confirmed.
 *
 * 2026-10-09: invitees with the right password read "Email ou senha
 * incorretos". The screen now names the state and offers "Reenviar
 * confirmação", and that button must come back if the action call itself
 * fails (network, deploy skew) instead of staying on "Reenviando..." forever.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LoginForm } from "./LoginForm";

const signIn = vi.hoisted(() => vi.fn());
const resend = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (value: string) => value }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/app/actions/auth/signInWithPassword", () => ({ signInWithPassword: signIn }));
vi.mock("@/app/actions/auth/resendConfirmation", () => ({ resendConfirmation: resend }));

async function loginUnconfirmed() {
  signIn.mockResolvedValue({ ok: false, error: "email_not_confirmed" });
  render(<LoginForm />);
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "pendente@example.com" } });
  fireEvent.change(screen.getByLabelText("Senha"), { target: { value: "SenhaCerta!2026" } });
  fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
  return screen.findByRole("button", { name: "Reenviar confirmação" });
}

describe("LoginForm — email not confirmed (Berseba)", () => {
  beforeEach(() => {
    signIn.mockReset();
    resend.mockReset();
  });

  it("names the state instead of 'Email ou senha incorretos'", async () => {
    await loginUnconfirmed();

    expect(screen.getByText(/ainda não foi confirmado/)).toBeInTheDocument();
    expect(screen.queryByText("Email ou senha incorretos.")).toBeNull();
  });

  it("resend goes to the email that was refused, and says it was sent", async () => {
    resend.mockResolvedValue({ ok: true });
    fireEvent.click(await loginUnconfirmed());

    expect(await screen.findByText("Enviamos um novo link de confirmação.")).toBeInTheDocument();
    expect(resend).toHaveBeenCalledWith({ email: "pendente@example.com" });
  });

  it("a rejected action call brings the button back, with a failure message", async () => {
    resend.mockRejectedValue(new Error("Failed to fetch"));
    fireEvent.click(await loginUnconfirmed());

    expect(
      await screen.findByText("Não foi possível reenviar agora. Tente de novo em instantes."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Reenviar confirmação" })).not.toBeDisabled(),
    );
  });
});
