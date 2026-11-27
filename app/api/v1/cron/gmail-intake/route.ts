/**
 * Berseba: the Gmail intake round, every 5 minutes (migration 9010).
 *
 * For each organization in GMAIL_INTAKE_ORG_IDS, every healthy mailbox is read
 * (`lib/integrations/gmail/intake.ts`). One mailbox failing never stops the others; its status
 * and error go on its row, and the screen shows them. Off (nothing read) without the config.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { appDoGmail, gmailIntakeConfig } from "@/lib/integrations/gmail/config";
import { levarEmailsAoFunil } from "@/lib/integrations/gmail/funil";
import { COLUNAS_DA_CAIXA, lerCaixa, PRAZO_DE_LEITURA_MS, type CaixaDoGmail } from "@/lib/integrations/gmail/intake";
import { logger } from "@/lib/logger";
import { idsDeOrgsParadas } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }
  const config = gmailIntakeConfig();
  if (!config) return ok({ caixas: [] }, { requestId });
  const app = await appDoGmail();
  if (!app) return ok({ caixas: [], motivo: "google_nao_configurado" }, { requestId });

  const admin = createAdminClient();
  const agora = new Date();
  const paradas = new Set(await idsDeOrgsParadas(admin));
  // One deadline for the whole run: a second mailbox never pushes it past the scheduler's 120 s.
  const prazo = Date.now() + PRAZO_DE_LEITURA_MS;
  const caixas: Array<Record<string, unknown>> = [];
  const funis: Array<Record<string, unknown>> = [];
  for (const org of config.orgIds) {
    if (paradas.has(org)) continue;
    const { data, error } = await admin
      .from("gmail_mailboxes")
      .select(COLUNAS_DA_CAIXA)
      .eq("organization_id", org)
      .eq("status", "healthy");
    if (error) {
      logger.warn("gmail_intake: mailboxes unreadable", { organization_id: org, error: error.message });
      continue;
    }
    for (const caixa of (data ?? []) as unknown as CaixaDoGmail[]) {
      try {
        const r = await lerCaixa(admin, app, caixa, agora, fetch, Date.now, prazo);
        caixas.push({ ...r, erro: r.erro ? "sim" : undefined });
      } catch (erro) {
        logger.warn("gmail_intake: mailbox run failed", {
          organization_id: org,
          mailbox_id: caixa.id,
          error: erro instanceof Error ? erro.message : String(erro),
        });
        caixas.push({ caixa: caixa.id, falhou: true });
      }
    }
    // Berseba (#171, slice 4): what was read reaches the contact and the funnel.
    try {
      const { data: todas } = await admin.from("gmail_mailboxes").select("account_email").eq("organization_id", org);
      const nossas = new Set(((todas ?? []) as Array<{ account_email: string }>).map((c) => c.account_email.toLowerCase()));
      funis.push({ organization_id: org, ...(await levarEmailsAoFunil(admin, org, nossas, agora)) });
    } catch (erro) {
      logger.warn("gmail_intake: funnel step failed", {
        organization_id: org,
        error: erro instanceof Error ? erro.message : String(erro),
      });
      funis.push({ organization_id: org, falhou: true });
    }
  }
  return ok({ caixas, funis }, { requestId });
}

export const GET = handle;
export const POST = handle;
