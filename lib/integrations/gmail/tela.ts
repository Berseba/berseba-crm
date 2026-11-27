/**
 * Berseba: what the e-mail screen shows (migration 9010) — the organization's mailboxes, the
 * threads of the last 30 days (automated ones left out), the names and open deals of the linked
 * contacts, and (#171, slice 2) one "precisa responder" queue with the e-mail threads that owe a
 * reply and the WhatsApp conversations waiting for a person, by the inbox's own rule
 * (`esperaUmaPessoa`, the same as the Painel and the Operação do dia). Service role, always
 * filtered by `organization_id`; the page checks the role.
 */
import { nomeDoContato, rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { STATUS_ENCERRADOS_LISTA } from "@/lib/inbox/comando-da-conversa";
import { esperaUmaPessoa, esperandoDesde, type ConversaParaEspera } from "@/lib/operacao/regras";
import { createAdminClient } from "@/lib/supabase/admin";

import { conversasDeEmail, type ConversaDeEmail, type MensagemGuardada } from "./conversas";
import { emailsAguardandoResposta } from "./fila";

export interface CaixaNaTela {
  id: string;
  user_id: string;
  account_email: string;
  status: string;
  last_sync_at: string | null;
  last_sync_error: string | null;
}

/** One item of the "precisa responder" queue, whatever the channel. */
export type ItemDaFila =
  | {
      canal: "email";
      chave: string;
      desde: string;
      nome: string;
      assunto: string;
      trecho: string | null;
      mailbox_id: string;
      gmail_thread_id: string;
      contact_id: string | null;
    }
  | {
      canal: "whatsapp";
      chave: string;
      desde: string;
      nome: string;
      trecho: string | null;
      conversation_id: string;
      contact_id: string | null;
    };

export interface TelaDeEmails {
  caixas: CaixaNaTela[];
  conversas: ConversaDeEmail[];
  fila: ItemDaFila[];
  nomes: Map<string, string>;
  negocios: Map<string, string>;
}

const DIAS = 30;
/** WhatsApp conversations read for the queue, oldest wait first (the Operação do dia's ceiling). */
const TETO_DO_WHATSAPP = 100;

type ConversaDaFila = ConversaParaEspera & {
  id: string;
  contact_id: string | null;
  last_message_preview: string | null;
  contacts: { name: string | null; display_name: string | null; phone_number: string | null } | null;
};

export async function lerTelaDeEmails(organizationId: string, agora: Date): Promise<TelaDeEmails> {
  const admin = createAdminClient();
  const desde = new Date(agora.getTime() - DIAS * 24 * 60 * 60 * 1000).toISOString();
  const [{ data: caixas }, { data: mensagens }, { data: whatsapp }] = await Promise.all([
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
      .limit(1000),
    admin
      .from("conversations")
      .select(
        "id, contact_id, status, comando_da_conversa, is_group, last_inbound_at, last_outbound_at, awaiting_since, " +
          "bot_silenced_until, assigned_to_user_id, last_message_preview, contacts(name, display_name, phone_number)",
      )
      .eq("organization_id", organizationId)
      .eq("is_group", false)
      .in("comando_da_conversa", ["aguardando", "ninguem", "humano"])
      .not("status", "in", `(${STATUS_ENCERRADOS_LISTA.join(",")})`)
      .order("awaiting_since", { ascending: true, nullsFirst: false })
      .limit(TETO_DO_WHATSAPP),
  ]);
  const todas = (mensagens ?? []) as MensagemGuardada[];
  const conversas = conversasDeEmail(todas).filter((c) => !c.automatica);

  const fila: ItemDaFila[] = [
    ...emailsAguardandoResposta(todas).map(
      (e): ItemDaFila => ({
        canal: "email",
        chave: `email:${e.mailbox_id}:${e.gmail_thread_id}`,
        desde: e.desde,
        nome: e.nome || e.contraparte,
        assunto: e.assunto,
        trecho: e.trecho,
        mailbox_id: e.mailbox_id,
        gmail_thread_id: e.gmail_thread_id,
        contact_id: e.contact_id,
      }),
    ),
    ...((whatsapp ?? []) as unknown as ConversaDaFila[])
      .filter((c) => esperaUmaPessoa(c, agora))
      .map(
        (c): ItemDaFila => ({
          canal: "whatsapp",
          chave: `whatsapp:${c.id}`,
          desde: esperandoDesde(c) ?? c.last_inbound_at ?? agora.toISOString(),
          nome: rotuloDoContato(c.contacts),
          trecho: c.last_message_preview,
          conversation_id: c.id,
          contact_id: c.contact_id,
        }),
      ),
  ].sort((a, b) => (a.desde < b.desde ? -1 : 1));

  const nomes = new Map<string, string>();
  const negocios = new Map<string, string>();
  const contatoIds = [
    ...new Set([...conversas, ...fila].flatMap((c) => (c.contact_id ? [c.contact_id] : []))),
  ];
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
      nomes.set(c.id, nomeDoContato(c) ?? "");
    }
    for (const l of (leads ?? []) as Array<{ id: string; contact_id: string }>) {
      if (!negocios.has(l.contact_id)) negocios.set(l.contact_id, l.id);
    }
  }
  return { caixas: (caixas ?? []) as CaixaNaTela[], conversas, fila, nomes, negocios };
}
