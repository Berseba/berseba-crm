/**
 * Berseba: GET /api/v1/gmail/callback — the way back from Google's consent (9010).
 *
 * Public in the proxy (the session cookie is `SameSite=Strict` and does not travel on a
 * navigation coming from accounts.google.com); the identity comes from the signed `state`, the
 * binding cookie and the single-use nonce, in the agenda callback's order
 * (`app/api/v1/agenda/google/callback/route.ts`): cancel → state → binding → code → nonce burn →
 * token exchange → scope → whose mailbox → allowlist → cipher → upsert. Every outcome goes back
 * to `/app/emails` through a same-origin bridge page, never a redirect (the Strict cookie would
 * not travel on the second hop).
 */
import { NextResponse, type NextRequest } from "next/server";

import { verificarEstado } from "@/lib/agenda/google/estado";
import { trocarCodigoPorToken } from "@/lib/agenda/google/token";
import { NOME_DO_VINCULO, vinculoConfere } from "@/lib/agenda/google/vinculo";
import { comIdDaRequisicao } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { supportCallbackWriteAllowed } from "@/lib/impersonate/support";
import { perfilDoGmail } from "@/lib/integrations/gmail/client";
import {
  appDoGmail,
  CAMINHO_DO_CALLBACK_GMAIL,
  contaPermitida,
  ESCOPO_GMAIL_LEITURA,
  gmailIntakeConfigFor,
  segredoDoEstadoDoGmail,
} from "@/lib/integrations/gmail/config";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";

function voltar(parametro: string, req: NextRequest): NextResponse {
  const base = env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const destino = new URL(`/app/emails?${parametro}`, base).toString();
  const seguro = destino.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const resposta = comIdDaRequisicao(
    new NextResponse(
      `<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><meta name="robots" content="noindex">` +
        `<noscript><meta http-equiv="refresh" content="0;url=${seguro}"></noscript>` +
        `<title>Voltando…</title></head><body><p>Voltando para os e-mails…</p>` +
        `<script>location.replace(${JSON.stringify(destino)})</script>` +
        `<noscript><p><a href="${seguro}">Continuar</a></p></noscript></body></html>`,
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    ),
    req,
  );
  resposta.cookies.set(NOME_DO_VINCULO, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: CAMINHO_DO_CALLBACK_GMAIL,
    maxAge: 0,
  });
  return resposta;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  if (url.searchParams.get("error")) return voltar("erro=conexao_cancelada", req);

  let estado: ReturnType<typeof verificarEstado> = null;
  try {
    estado = verificarEstado(url.searchParams.get("state"), { segredo: segredoDoEstadoDoGmail(), agora: new Date() });
  } catch {
    return voltar("erro=retorno_nao_verificavel", req);
  }
  if (!estado) return voltar("erro=retorno_nao_verificavel", req);
  const { organizationId, userId } = estado;

  // The binding before the nonce burn: a leaked state must not let anyone burn the owner's nonce.
  if (!vinculoConfere(req.cookies.get(NOME_DO_VINCULO)?.value, estado.nonce, segredoDoEstadoDoGmail())) {
    await audit({ action: "gmail.conexao_falhou", organizationId, metadata: { reason: "vinculo", user_id: userId } });
    return voltar("erro=retorno_nao_verificavel", req);
  }
  const code = url.searchParams.get("code");
  if (!code) return voltar("erro=retorno_incompleto", req);

  const config = gmailIntakeConfigFor(organizationId);
  if (!config) return voltar("erro=gmail_desligado", req);
  const app = await appDoGmail();
  if (!app) return voltar("erro=google_nao_configurado", req);

  if (!(await supportCallbackWriteAllowed(organizationId, userId, estado.authSessionId))) {
    return voltar("erro=retorno_nao_verificavel", req);
  }
  // Single use: the agenda's nonce table, whose primary key is the nonce (migration 0190).
  const admin = createAdminClient();
  const { error: erroDoNonce } = await admin.from("calendar_oauth_nonces").insert({
    nonce: estado.nonce,
    organization_id: organizationId,
    user_id: userId,
    expira_em: new Date(estado.expiraEmMs).toISOString(),
  });
  if (erroDoNonce) {
    await audit({
      action: "gmail.conexao_falhou",
      organizationId,
      metadata: { reason: erroDoNonce.code === "23505" ? "state_reutilizado" : "nonce_indisponivel", user_id: userId },
    });
    return voltar("erro=retorno_nao_verificavel", req);
  }

  const leitura = await trocarCodigoPorToken(app, code, { agora: new Date() });
  if (!leitura.ok) {
    await audit({
      action: "gmail.conexao_falhou",
      organizationId,
      metadata: { reason: leitura.motivo, detalhe: leitura.detalhe, user_id: userId },
    });
    return voltar("erro=troca_de_codigo_falhou", req);
  }
  const token = leitura.token;
  if (!token.scope.includes(ESCOPO_GMAIL_LEITURA)) {
    await audit({ action: "gmail.conexao_falhou", organizationId, metadata: { reason: "scope_missing", user_id: userId } });
    return voltar("erro=permissao_incompleta", req);
  }
  if (!token.refresh_token) return voltar("erro=sem_renovacao", req);

  const perfil = await perfilDoGmail(token.access_token);
  const conta = perfil.ok ? perfil.dados.emailAddress?.trim().toLowerCase() : undefined;
  if (!conta) {
    await audit({
      action: "gmail.conexao_falhou",
      organizationId,
      metadata: { reason: "perfil_indisponivel", detalhe: perfil.ok ? null : perfil.erro, user_id: userId },
    });
    return voltar("erro=conta_indisponivel", req);
  }
  // LGPD: only the mailboxes the installation lists. Anything else is refused, and nothing of it
  // is stored (the tokens are dropped here).
  if (!contaPermitida(config, conta)) {
    await audit({ action: "gmail.conexao_falhou", organizationId, metadata: { reason: "conta_fora_da_lista", user_id: userId } });
    return voltar("erro=conta_nao_permitida", req);
  }

  const accessCifrado = await encryptWebhookSecret(admin, token.access_token);
  const refreshCifrado = await encryptWebhookSecret(admin, token.refresh_token);
  if (!accessCifrado || !refreshCifrado) return voltar("erro=cifra_indisponivel", req);

  const { error } = await admin.from("gmail_mailboxes").upsert(
    {
      organization_id: organizationId,
      user_id: userId,
      account_email: conta,
      oauth_access_token_encrypted: accessCifrado,
      oauth_refresh_token_encrypted: refreshCifrado,
      token_expires_at: token.expira_em,
      scopes: token.scope,
      status: "healthy",
      last_sync_error: null,
    },
    { onConflict: "organization_id,user_id" },
  );
  if (error) {
    await audit({ action: "gmail.conexao_falhou", organizationId, metadata: { reason: "gravar", detalhe: error.message, user_id: userId } });
    return voltar("erro=gravar_falhou", req);
  }
  await audit({ action: "gmail.caixa_conectada", organizationId, metadata: { user_id: userId, conta } });
  return voltar("ok=1", req);
}
