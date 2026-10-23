"use server";

import { headers } from "next/headers";

import { createClient } from "@/lib/supabase/server";
import {
  signupSchema,
  signupComConviteSchema,
  type SignupInput,
  type SignupComConviteInput,
} from "@/lib/auth/schemas";
import { verifyInviteToken } from "@/lib/auth/invite-token";
import { completeInviteSignup } from "@/lib/auth/invite-signup";
import { modoDeCadastro } from "@/lib/auth/politica-de-cadastro";
import { audit, hashEmail } from "@/lib/audit";
import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

export type SignUpResult =
  | {
      ok: true;
      /**
       * O provedor de auth JÁ abriu a sessão neste `signUp()` — quer dizer,
       * "Confirm email" está DESLIGADO nele e não vai existir link nenhum para
       * clicar. Quem chama precisa saber disto: a tela de "confirme seu e-mail"
       * é uma instrução impossível de cumprir nesse estado, e a pessoa fica
       * esperando para sempre um e-mail que nunca sai — autenticada, sem
       * organização, sem motivo para navegar até a saída que existe.
       *
       * Medido em 2026-09-05 na `origin/main` @ `4d50f63f`, com
       * `GOTRUE_MAILER_AUTOCONFIRM=true`: a tela dizia "Enviamos um link de
       * confirmação para …", e ao mesmo tempo o cookie `sb-deskcomm-auth`
       * estava no browser e `user_organizations` do usuário vinha `[]`.
       *
       * Achado de @KIRAzinx566, com um cliente real travado nessa tela.
       */
      sessao_ativa: boolean;
      /**
       * Berseba: where the screen goes next, when the action already knows.
       * Set on invite signup, which confirms the account and applies the
       * invite in the same request (`lib/auth/invite-signup.ts`).
       */
      destino?: string;
    }
  | {
      ok: false;
      /**
       * `somente_convite`: a instalação está em modo `so_convite` e esta
       * tentativa não trouxe convite válido. É recusa de POLÍTICA, não de
       * dado — por isso não vira `validation_error`: a pessoa não tem o que
       * corrigir no formulário.
       *
       * `conta_ja_existe`: só acontece COM convite na mão. Sem convite a
       * resposta continua indistinguível de sucesso — ver o parágrafo de
       * anti-enumeração abaixo. Os dois convivem sem se confundir: a recusa por
       * política é decidida ANTES de tocar no GoTrue, então numa instalação
       * fechada quem chega sem convite nunca chega a saber se o e-mail existe.
       */
      error:
        | "validation_error"
        | "rate_limited"
        | "signup_failed"
        | "somente_convite"
        | "conta_ja_existe";
      details?: Record<string, unknown>;
    };

/**
 * Signup self-service: cria o usuário no GoTrue e dispara o e-mail de
 * confirmação. O tenant só é provisionado quando o link é confirmado em
 * /auth/confirm (evita orgs órfãs de cadastros nunca confirmados).
 *
 * Anti-enumeração: e-mail já cadastrado recebe a MESMA resposta de sucesso —
 * o GoTrue devolve um usuário ofuscado (identities vazio) sem erro, e nós não
 * diferenciamos. Rate limit de envio de e-mail é do próprio GoTrue.
 */
export async function signUp(
  input: SignupInput | SignupComConviteInput,
  /**
   * Token de convite, quando a conta está sendo criada para ACEITAR um convite.
   * Viaja até `/auth/confirm` pelo `user_metadata` — o mesmo canal que
   * `org_name` já usa e que o e2e do signup exercita. Ele não dá acesso a nada
   * sozinho: quem decide é `decidirConviteDoSignup`, comparando a assinatura do
   * token com o e-mail que o provedor de auth confirmou.
   */
  inviteToken?: string,
): Promise<SignUpResult> {
  const temConvite = typeof inviteToken === "string" && inviteToken.trim() !== "";
  const parsed = temConvite
    ? signupComConviteSchema.safeParse(input)
    : signupSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "validation_error",
      details: parsed.error.flatten().fieldErrors,
    };
  }

  const hdrs = await headers();
  const origin = hdrs.get("origin") ?? env.NEXT_PUBLIC_APP_URL;
  const requestId = hdrs.get("x-request-id");
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = hdrs.get("user-agent") ?? null;

  // Criar conta é fluxo raro por pessoa: teto baixo por IP evita fábrica de
  // organizações (cada signup provisiona tenant). Issue #64.
  if (await authRateLimited("signup", null, AUTH_LIMITS.signup)) {
    return { ok: false, error: "rate_limited" };
  }

  // Só vira convite se o token verificar E for para este e-mail. Divergência
  // aqui não é erro do usuário — é tentativa de entrar em organização alheia
  // colando um token que chegou para outra pessoa.
  let convite: string | null = null;
  if (temConvite && inviteToken) {
    const payload = verifyInviteToken(inviteToken);
    if (!payload) {
      return { ok: false, error: "validation_error", details: { invite: ["convite_invalido"] } };
    }
    if (payload.email.trim().toLowerCase() !== parsed.data.email.trim().toLowerCase()) {
      return { ok: false, error: "validation_error", details: { invite: ["email_divergente"] } };
    }
    convite = inviteToken;
  }

  // ── A AUTORIDADE da política de cadastro ──────────────────────────────────
  // A tela também recusa, mas a tela é adulterável: esta action é chamável
  // direto, e sem esta guarda o modo `so_convite` seria decoração. A ordem
  // importa — só se pergunta a política DEPOIS de o convite ter sido validado
  // acima, senão um convite legítimo seria barrado.
  if (convite === null && (await modoDeCadastro()) === "so_convite") {
    await audit({
      action: "auth.signup_failed",
      metadata: { email_hash: hashEmail(parsed.data.email), reason: "somente_convite" },
      requestId,
      ip,
      userAgent,
    });
    return { ok: false, error: "somente_convite" };
  }

  // ── Berseba: invite signup is confirmed by the invite itself ─────────────
  //
  // A valid invite for this exact email (checked above) is the proof of the
  // address, so the account is created already confirmed and joins the
  // organization in this same request. No confirmation email: on 2026-10-09
  // that email never reached two invitees and locked them out
  // (`lib/auth/invite-signup.ts` has the incident and the trade-off). This also
  // covers upstream's `disable_signup` case (#1653): the admin API does not
  // depend on public signup being open.
  if (convite !== null) {
    const result = await completeInviteSignup({
      email: parsed.data.email,
      password: parsed.data.password,
      fullName: (parsed.data as SignupComConviteInput).full_name,
      inviteToken: convite,
      requestId,
    });

    if (!result.ok) {
      await audit({
        action: "auth.signup_failed",
        metadata: {
          email_hash: hashEmail(parsed.data.email),
          // `conta_ja_existe_com_convite` keeps the vocabulary the trail
          // already uses for this case.
          reason: result.reason === "account_exists" ? "conta_ja_existe_com_convite" : result.reason,
          detalhe: result.detail ?? null,
          via: "invite_confirmed",
        },
        requestId,
        ip,
        userAgent,
      });
      if (result.reason === "account_exists") return { ok: false, error: "conta_ja_existe" };
      if (result.reason === "rate_limited") return { ok: false, error: "rate_limited" };
      if (result.reason === "invalid_invite" || result.reason === "invite_revoked") {
        return { ok: false, error: "validation_error", details: { invite: ["convite_invalido"] } };
      }
      return { ok: false, error: "signup_failed" };
    }

    await audit({
      action: "auth.signup_confirmed",
      actorUserId: result.userId,
      metadata: { via: "invite_confirmed", account_created: result.created },
      requestId,
      ip,
      userAgent,
    });

    // Open the session now, so the person lands inside the organization
    // instead of on a login screen. If this fails the account and the
    // membership are already in place: the login screen finishes the job.
    const supabase = await createClient();
    const { data: signedIn, error: signInError } = await supabase.auth.signInWithPassword({
      email: parsed.data.email,
      password: parsed.data.password,
    });
    if (signedIn?.session) return { ok: true, sessao_ativa: true, destino: "/app" };
    logger.warn("invite signup: account ready but the session could not be opened", {
      user_id: result.userId,
      detail: signInError?.message ?? "no session returned",
    });
    return { ok: true, sessao_ativa: false, destino: "/login" };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      // Ver comentário equivalente em requestPasswordReset.ts: ?type=signup
      // sobrevive ao redirect do GoTrue e é o que distingue este fluxo do de
      // recovery quando a verificação chega via `code` (PKCE), não `token_hash`.
      emailRedirectTo: `${origin}/auth/confirm?type=signup`,
      // O convite é revalidado no servidor mesmo tendo sido validado ao montar
      // a tela: o campo de e-mail do formulário é adulterável no cliente, e a
      // decisão que importa acontece com o e-mail JÁ confirmado pelo provedor.
      // `full_name` vai junto no convite: sem ele a pessoa entra na equipe sem
      // nome e aparece como um pedaço de identificador em toda tela que a
      // nomeia. No caminho sem convite ele não existe — ali quem dá o nome é o
      // onboarding, que o convidado não percorre.
      data: convite
        ? {
            invite_token: convite,
            full_name: (parsed.data as SignupComConviteInput).full_name,
          }
        : { org_name: (parsed.data as SignupInput).org_name },
    },
  });

  if (error) {
    if (error.status === 429) return { ok: false, error: "rate_limited" };

    // ── O BECO SEM SAÍDA DE QUEM JÁ TEM CONTA ────────────────────────────
    //
    // Medido em produção em 2026-09-10: quem foi revogado e recebeu convite
    // novo chega aqui, porque já tem conta. O GoTrue devolve
    // "User already registered", e a tela dizia "Não foi possível criar a
    // conta. Tente novamente." — instrução impossível: tentar de novo nunca
    // vai funcionar. A pessoa tentou TRÊS vezes; está nas três linhas de
    // `auth.signup_failed` da trilha.
    //
    // O caminho certo existe e é curto (entrar e aceitar o convite), mas a
    // tela não levava até ele.
    //
    // ⚠️ POR QUE ISTO NÃO FURA A ANTI-ENUMERAÇÃO. O cabeçalho desta função
    // explica que e-mail já cadastrado recebe a MESMA resposta de sucesso,
    // para ninguém descobrir quem tem conta aqui testando endereços. A regra
    // continua inteira: este ramo só existe quando há um CONVITE ASSINADO
    // para este e-mail. Quem tem o convite já sabe que este endereço foi
    // convidado — a assinatura é a prova. Sem convite, `convite` é `null` e a
    // resposta segue sendo `signup_failed`, indistinguível como antes.
    const jaExiste = /already\s*registered|already\s*exists/i.test(error.message);
    if (jaExiste && convite !== null) {
      await audit({
        action: "auth.signup_failed",
        metadata: {
          email_hash: hashEmail(parsed.data.email),
          reason: "conta_ja_existe_com_convite",
        },
        requestId,
        ip,
        userAgent,
      });
      return { ok: false, error: "conta_ja_existe" };
    }

    await audit({
      action: "auth.signup_failed",
      metadata: {
        email_hash: hashEmail(parsed.data.email),
        reason: error.message,
      },
      requestId,
      ip,
      userAgent,
    });
    return { ok: false, error: "signup_failed" };
  }

  await audit({
    action: "auth.signup_requested",
    actorUserId: data.user?.id ?? null,
    metadata: { email_hash: hashEmail(parsed.data.email) },
    requestId,
    ip,
    userAgent,
  });

  // `data.session` é o único sinal confiável de que o provedor não vai mandar
  // e-mail nenhum: ele vem preenchido exatamente quando a confirmação está
  // desligada (ou já resolvida) e o GoTrue devolveu tokens junto do usuário.
  return { ok: true, sessao_ativa: data.session !== null };
}
