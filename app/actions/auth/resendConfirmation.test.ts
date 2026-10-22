/**
 * Berseba: "Reenviar confirmação" on the login screen.
 *
 * What is measured: it asks GoTrue for a SIGNUP email pointing back at
 * `/auth/confirm?type=signup`, it has a ceiling, and its answer does not depend
 * on whether the address has an account (GoTrue already answers 200 for both).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
}));

const resend = vi.fn();
let n = 0;

describe("resendConfirmation (Berseba)", () => {
  beforeEach(() => {
    vi.resetModules();
    resend.mockReset();
    vi.mocked(audit).mockClear();
    n++;
    vi.mocked(headers).mockResolvedValue({
      get: (k: string) =>
        k === "x-forwarded-for" ? `198.51.100.${n}` : k === "origin" ? "https://crm.example.test" : null,
    } as never);
    vi.mocked(createClient).mockResolvedValue({ auth: { resend } } as never);
  });

  it("asks for a signup email back to /auth/confirm, and audits it", async () => {
    resend.mockResolvedValue({ data: {}, error: null });
    const { resendConfirmation } = await import("./resendConfirmation");

    const res = await resendConfirmation({ email: "pendente@example.com" });

    expect(res).toEqual({ ok: true });
    expect(resend).toHaveBeenCalledWith({
      type: "signup",
      email: "pendente@example.com",
      options: { emailRedirectTo: "https://crm.example.test/auth/confirm?type=signup" },
    });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.signup_confirmation_resent" }),
    );
  });

  it("the same answer for an address with no account (GoTrue answers 200 for it)", async () => {
    resend.mockResolvedValue({ data: {}, error: null });
    const { resendConfirmation } = await import("./resendConfirmation");

    expect(await resendConfirmation({ email: "ninguem@example.com" })).toEqual({ ok: true });
  });

  it("has a ceiling per address: the 4th request within the hour is refused", async () => {
    resend.mockResolvedValue({ data: {}, error: null });
    const { resendConfirmation } = await import("./resendConfirmation");
    const email = `teto-${Date.now()}@example.com`;

    const results = [];
    for (let i = 0; i < 4; i++) results.push(await resendConfirmation({ email }));

    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(results[3]).toEqual({ ok: false, error: "rate_limited" });
    expect(resend).toHaveBeenCalledTimes(3);
  });

  it("an invalid email never reaches GoTrue", async () => {
    const { resendConfirmation } = await import("./resendConfirmation");

    expect(await resendConfirmation({ email: "não-é-email" })).toEqual({ ok: false, error: "validation_error" });
    expect(resend).not.toHaveBeenCalled();
  });
});
