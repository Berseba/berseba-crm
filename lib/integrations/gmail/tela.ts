/**
 * Berseba: what the e-mail screen shows (migration 9010) — the organization's mailboxes, the
 * threads of the last 30 days (automated ones left out), and the names and open deals of the
 * linked contacts. Service role, always filtered by `organization_id`; the page checks the role.
 */
import { createAdminClient } from "@/lib/supabase/admin";

import { conversasDeEmail, type ConversaDeEmail, type MensagemGuardada } from "./conversas";

export interface CaixaNaTela {
  id: string;
  user_id: string;
  account_email: string;
  status: string;
  last_sync_at: string | null;
  last_sync_error: string | null;
}

export interface TelaDeEmails {
  caixas: CaixaNaTela[];
  conversas: ConversaDeEmail[];
  nomes: Map<string, string>;
  negocios: Map<string, string>;
}

const DIAS = 30;

export async function lerTelaDeEmails(organizationId: string, agora: Date): Promise<TelaDeEmails> {
  const admin = createAdminClient();
  const desde = new Date(agora.getTime() - DIAS * 24 * 60 * 60 * 1000).toISOString();
  const [{ data: caixas }, { data: mensagens }] = await Promise.all([
    admin
      .from("gmail_mailboxes")
      .select("id, user_id, account_email, status, last_sync_at, last_sync_error")
      .eq("organization_id", organizationId)
      .order("account_email"),
    admin
      .from("gmail_messages")
      .select(
        "id, mailbox_id, gmail_thread_id, direction, from_email, from_name, subject, snippet, is_automated, sent_at, counterpart_email, contact_id",
      )
      .eq("organization_id", organizationId)
      .gte("sent_at", desde)
      .order("sent_at", { ascending: false })
      .limit(400),
  ]);
  const conversas = conversasDeEmail((mensagens ?? []) as MensagemGuardada[]).filter((c) => !c.automatica);

  const nomes = new Map<string, string>();
  const negocios = new Map<string, string>();
  const contatoIds = [...new Set(conversas.flatMap((c) => (c.contact_id ? [c.contact_id] : [])))];
  if (contatoIds.length > 0) {
    const [{ data: contatos }, { data: leads }] = await Promise.all([
      admin.from("contacts").select("id, name, display_name").eq("organization_id", organizationId).in("id", contatoIds),
      admin
        .from("crm_leads")
        .select("id, contact_id, updated_at")
        .eq("organization_id", organizationId)
        .eq("status", "open")
        .in("contact_id", contatoIds)
        .order("updated_at", { ascending: false }),
    ]);
    for (const c of (contatos ?? []) as Array<{ id: string; name: string | null; display_name: string | null }>) {
      nomes.set(c.id, c.display_name || c.name || "");
    }
    for (const l of (leads ?? []) as Array<{ id: string; contact_id: string }>) {
      if (!negocios.has(l.contact_id)) negocios.set(l.contact_id, l.id);
    }
  }
  return { caixas: (caixas ?? []) as CaixaNaTela[], conversas, nomes, negocios };
}
