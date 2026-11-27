/**
 * Berseba: POST /api/v1/gmail/disconnect — the partner disconnects their own Gmail (9010).
 *
 * Forgets the tokens and stops the intake; the e-mails already read stay (they are the
 * company's correspondence with its contacts, and leave with the contact's anonymization).
 * Revoking the app's access in the Google account is the partner's own step, and the screen
 * says so.
 */
import { NextResponse, type NextRequest } from "next/server";

import { comIdDaRequisicao } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const autorizado = await requireRole("admin", { requestId, resource: "gmail_mailboxes" });
  if (!autorizado.ok) return autorizado.response;
  const { user, org } = autorizado;

  const { error } = await createAdminClient()
    .from("gmail_mailboxes")
    .update({
      status: "disconnected",
      oauth_access_token_encrypted: null,
      oauth_refresh_token_encrypted: null,
      token_expires_at: null,
    })
    .eq("organization_id", org.orgId)
    .eq("user_id", user.id);
  const base = env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  if (error) return comIdDaRequisicao(NextResponse.redirect(new URL("/app/emails?erro=gravar_falhou", base), 303), req);
  await audit({ action: "gmail.caixa_desconectada", organizationId: org.orgId, metadata: { user_id: user.id } });
  return comIdDaRequisicao(NextResponse.redirect(new URL("/app/emails?desconectado=1", base), 303), req);
}
