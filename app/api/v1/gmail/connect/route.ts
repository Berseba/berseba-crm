/**
 * Berseba: GET /api/v1/gmail/connect — a partner connects their own Gmail, read-only (9010).
 *
 * Admin only, in an organization listed in GMAIL_INTAKE_ORG_IDS. Same flow as the agenda's
 * (`app/api/v1/agenda/google/connect/route.ts`): a signed `state` with a single-use nonce, plus a
 * `SameSite=Lax` binding cookie that proves the browser coming back is the one that left. The
 * state is signed with this flow's own key, so an agenda state never opens it.
 */
import { randomBytes } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { emitirEstado } from "@/lib/agenda/google/estado";
import { assinarVinculo, NOME_DO_VINCULO, VALIDADE_DO_VINCULO_S } from "@/lib/agenda/google/vinculo";
import { comIdDaRequisicao } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { authenticatedSessionId, requireSupportWrite } from "@/lib/impersonate/support";
import {
  appDoGmail,
  CAMINHO_DO_CALLBACK_GMAIL,
  gmailIntakeConfigFor,
  segredoDoEstadoDoGmail,
  urlDeConsentimentoDoGmail,
} from "@/lib/integrations/gmail/config";
import { cookieSecure } from "@/lib/supabase/cookie-secure";

export const dynamic = "force-dynamic";

function voltarComErro(codigo: string, req: NextRequest): NextResponse {
  const base = env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return comIdDaRequisicao(NextResponse.redirect(new URL(`/app/emails?erro=${codigo}`, base)), req);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = req.headers.get("x-request-id") ?? undefined;

  const autorizado = await requireRole("admin", { requestId, resource: "gmail_mailboxes" });
  if (!autorizado.ok) return autorizado.response;
  const { user, org } = autorizado;

  if (!gmailIntakeConfigFor(org.orgId)) return voltarComErro("gmail_desligado", req);
  const app = await appDoGmail();
  if (!app) return voltarComErro("google_nao_configurado", req);

  const nonce = randomBytes(16).toString("base64url");
  let state: string;
  try {
    state = emitirEstado(
      { organizationId: org.orgId, userId: user.id, authSessionId: await authenticatedSessionId() },
      { segredo: segredoDoEstadoDoGmail(), agora: new Date(), nonce },
    );
  } catch {
    return voltarComErro("segredo_indisponivel", req);
  }

  await audit({ action: "gmail.conexao_iniciada", organizationId: org.orgId, metadata: { user_id: user.id } });

  const resposta = comIdDaRequisicao(
    NextResponse.redirect(urlDeConsentimentoDoGmail(app, { state, contaSugerida: user.email })),
    req,
  );
  resposta.cookies.set(NOME_DO_VINCULO, assinarVinculo(nonce, segredoDoEstadoDoGmail()), {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: CAMINHO_DO_CALLBACK_GMAIL,
    maxAge: VALIDADE_DO_VINCULO_S,
  });
  return resposta;
}
