"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";

import { useT } from "@/hooks/i18n/useT";
import { loginSchema, type LoginInput } from "@/lib/auth/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signInWithPassword } from "@/app/actions/auth/signInWithPassword";
import { resendConfirmation } from "@/app/actions/auth/resendConfirmation";
import { Eye, EyeSlash } from "@/lib/ui/icons";

export function LoginForm({ next }: { next?: string }) {
  const t = useT();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  // Berseba: the email of a login that answered `email_not_confirmed`; it
  // drives the notice with the "Reenviar confirmação" button.
  const [unconfirmedEmail, setUnconfirmedEmail] = useState<string | null>(null);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent" | "failed" | "rate_limited">("idle");

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = (values: LoginInput) => {
    setServerError(null);
    setUnconfirmedEmail(null);
    setResendState("idle");
    startTransition(async () => {
      // Server Action redirects on success — no return value reaches here.
      // On failure, an error discriminator is returned and rendered inline.
      const res = await signInWithPassword(values, next);
      if (!res) {
        // Should be unreachable (redirect throws), but guard anyway.
        router.replace(next || "/app");
        return;
      }
      if (res.error === "mfa_required") {
        const params = new URLSearchParams();
        if (next) params.set("next", next);
        if (res.challengeId) params.set("factor", res.challengeId);
        router.replace(`/login/mfa${params.toString() ? `?${params}` : ""}`);
        return;
      }
      if (res.error === "email_not_confirmed") {
        setUnconfirmedEmail(values.email);
        return;
      }
      if (res.error === "invalid_credentials") {
        setServerError(t("Email ou senha incorretos."));
      } else if (res.error === "rate_limited") {
        setServerError(t("Muitas tentativas. Aguarde alguns minutos."));
      } else if (res.error === "validation_error") {
        setServerError(t("Dados inválidos. Confira os campos."));
      } else {
        setServerError(t("Erro inesperado. Tente novamente."));
      }
    });
  };

  const onResend = async () => {
    const email = unconfirmedEmail ?? getValues("email");
    setResendState("sending");
    const res = await resendConfirmation({ email });
    if (res.ok) setResendState("sent");
    else setResendState(res.error === "rate_limited" ? "rate_limited" : "failed");
  };

  return (
    <form method="post" onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="email">{t("Email")}</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          autoFocus
          aria-invalid={errors.email ? true : undefined}
          {...register("email")}
        />
        {errors.email && (
          <p className="text-xs text-destructive">{t(errors.email.message ?? "")}</p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">{t("Senha")}</Label>
        <div className="relative">
          <Input
            id="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            className="pr-12"
            aria-invalid={errors.password ? true : undefined}
            {...register("password")}
          />
          <button
            type="button"
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:outline-hidden focus-visible:ring-inset"
            aria-pressed={showPassword}
            onClick={() => setShowPassword((visible) => !visible)}
          >
            {/* Nome em sr-only, não aria-label: getByLabel(/senha/i) casa aria-label e acharia o botão junto do campo. */}
            <span className="sr-only">{t(showPassword ? "Ocultar senha" : "Mostrar senha")}</span>
            {showPassword ? <EyeSlash size={20} aria-hidden /> : <Eye size={20} aria-hidden />}
          </button>
        </div>
        {errors.password && (
          <p className="text-xs text-destructive">{t(errors.password.message ?? "")}</p>
        )}
      </div>
      {unconfirmedEmail && (
        <div
          className="space-y-2 rounded-md border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning-fg"
          role="alert"
        >
          <p>
            {t(
              "Seu e-mail ainda não foi confirmado. Abra o link que enviamos para a sua caixa de entrada (confira também o spam) e depois entre de novo.",
            )}
          </p>
          {resendState === "sent" ? (
            <p role="status">{t("Enviamos um novo link de confirmação.")}</p>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={resendState === "sending"}
              onClick={onResend}
            >
              {resendState === "sending" ? t("Reenviando...") : t("Reenviar confirmação")}
            </Button>
          )}
          {resendState === "rate_limited" && (
            <p>{t("Muitas tentativas. Aguarde alguns minutos.")}</p>
          )}
          {resendState === "failed" && (
            <p>{t("Não foi possível reenviar agora. Tente de novo em instantes.")}</p>
          )}
        </div>
      )}
      {serverError && (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {serverError}
        </div>
      )}
      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? t("Entrando...") : t("Entrar")}
      </Button>
    </form>
  );
}
