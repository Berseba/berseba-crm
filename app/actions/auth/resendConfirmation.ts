"use server";

import { headers } from "next/headers";

import { createClient } from "@/lib/supabase/server";
import { forgotPasswordSchema, type ForgotPasswordInput } from "@/lib/auth/schemas";
import { audit, hashEmail } from "@/lib/audit";
import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";
import { env } from "@/lib/env";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";

export type ResendConfirmationResult =
  | { ok: true }
  | { ok: false; error: "validation_error" | "rate_limited" | "request_failed" };

/**
 * Berseba: "Reenviar confirmação" on the login screen, shown when the login
 * answered `email_not_confirmed` (`signInWithPassword.ts`).
 *
 * Neutral about whether the email exists: GoTrue's `POST /resend` answers 200
 * with `{}` both for an unknown email and for an already confirmed one
 * (supabase/auth `internal/api/resend.go`), and this action adds nothing on
 * top. The ceiling reuses the password-reset numbers under its own bucket: it
 * is the same kind of request (send one email to an address someone typed),
 * and it should not spend the reset budget of the same person.
 *
 * This email goes through the Supabase Auth SMTP. If that SMTP does not
 * deliver (the 2026-10-09 incident), resending does not deliver either; see
 * `docs/runbooks/supabase-auth-smtp.md`.
 */
export async function resendConfirmation(
  input: ForgotPasswordInput,
): Promise<ResendConfirmationResult> {
  const parsed = forgotPasswordSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation_error" };

  const hdrs = await headers();
  const origin = hdrs.get("origin") ?? env.NEXT_PUBLIC_APP_URL;
  const requestId = hdrs.get("x-request-id");
  const ip = ipDoCliente(hdrs);
  const userAgent = hdrs.get("user-agent") ?? null;

  if (await authRateLimited("resend_confirmation", parsed.data.email, AUTH_LIMITS.reset)) {
    return { ok: false, error: "rate_limited" };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resend({
    type: "signup",
    email: parsed.data.email,
    // Same target as `signUp.ts`: `?type=signup` survives the GoTrue redirect.
    options: { emailRedirectTo: `${origin}/auth/confirm?type=signup` },
  });

  await audit({
    action: "auth.signup_confirmation_resent",
    metadata: {
      email_hash: hashEmail(parsed.data.email),
      ...(error ? { failed: true, reason: error.message } : {}),
    },
    requestId,
    ip,
    userAgent,
  });

  if (error) {
    if (error.status === 429) return { ok: false, error: "rate_limited" };
    return { ok: false, error: "request_failed" };
  }
  return { ok: true };
}
