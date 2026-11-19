/**
 * Berseba: the avec salon's waitlist round, every 10 minutes.
 *
 * For each organization allowed to use avec (`AVEC_API_ORG_IDS`) with the waitlist on: entries
 * whose days are over leave the list, offers past their deadline give the slot to the next one,
 * then every waiting entry is searched in avec in the queue's order. A stopped organization is
 * skipped: `configDaEspera` reads `ehOperante` (lib/agenda/encaixe-supabase.ts).
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { avecConfig } from "@/lib/integrations/avec/config";
import { rodadaAvec } from "@/lib/integrations/avec/lista-de-espera-supabase";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }
  const orgs = [...(avecConfig()?.orgIds ?? [])];
  const admin = createAdminClient();
  const agora = new Date();
  const rodadas: Array<Record<string, unknown>> = [];
  for (const org of orgs) {
    try {
      const r = await rodadaAvec(admin, org, agora);
      if (r) rodadas.push({ organization_id: org, ...r });
    } catch (erro) {
      // One organization failing never stops the others; the next round tries again.
      logger.warn("avec_waitlist: round failed", {
        organization_id: org,
        error: erro instanceof Error ? erro.message : String(erro),
      });
      rodadas.push({ organization_id: org, falhou: true });
    }
  }
  return ok({ rodadas }, { requestId });
}

export const GET = handle;
export const POST = handle;
