/**
 * Berseba: what the e-mail screen shows (migration 9010) — the organization's mailboxes, the
 * threads of the last 30 days (automated ones left out), the names and open deals of the linked
 * contacts, and (#171, slice 2) one "precisa responder" queue: the clients waiting for an e-mail
 * reply (`emailsAguardandoResposta`, its own read of 60 days) and the conversations waiting for a
 * person, by the same rule and query as the Operação do dia (`esperaUmaPessoa`/`esperandoDesde`
 * of `lib/operacao/regras.ts`; the Painel's Aguardando column counts differently). A list cut by
 * its ceiling and a failed read are reported, never shown as an empty queue. Service role, always
 * filtered by `organization_id`; the page checks the role.
 */
import { nomeDoContato, type ContatoNomeavel } from "@/lib/contacts/rotulo-do-contato";
import { STATUS_ENCERRADOS_LISTA } from "@/lib/inbox/comando-da-conversa";
import { esperaUmaPessoa, esperandoDesde, type ConversaParaEspera } from "@/lib/operacao/regras";
import { createAdminClient } from "@/lib/supabase/admin";

import { conversasDeEmail, type ConversaDeEmail, type MensagemGuardada } from "./conversas";
import { emailsAguardandoResposta, type MensagemDaFila } from "./fila";

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
      assunto: string | null;
      trecho: string | null;
      mailbox_id: string;
      gmail_thread_id: string;
      contact_id: string | null;
    }
  | {
      canal: "conversa";
      /** `conversations.channel`: whatsapp, instagram, facebook, telegram. */
      rede: string;
      chave: string;
      desde: string;
      contato: ContatoNomeavel | null;
      trecho: string | null;
      conversation_id: string;
      contact_id: string | null;
    };

export interface TelaDeEmails {
  caixas: CaixaNaTela[];
  conversas: ConversaDeEmail[];
  fila: ItemDaFila[];
  /** A list hit its ceiling: the oldest waits may be missing. */
  filaCortada: boolean;
  /** A read failed: the queue is not trustworthy right now. */
  filaFalhou: boolean;
  nomes: Map<string, string>;
  negocios: Map<string, string>;
}

const DIA_MS = 24 * 60 * 60 * 1000;
const DIAS_DA_LISTA = 30;
const DIAS_DA_FILA = 60;
const TETO_DA_LISTA = 1000;
const TETO_DA_FILA_DE_EMAIL = 3000;
/** Conversations read for the queue, oldest wait first. */
const TETO_DAS_CONVERSAS = 300;

type ConversaDaFila = ConversaParaEspera & {
  id: string;
  channel: string;
  contact_id: string | null;
  last_message_preview: string | null;
  contacts: ContatoNomeavel | null;
};

const ms = (iso: string) => Date.parse(iso);

function pedacos<T>(lista: T[], tamanho = 100): T[][] {
  const saida: T[][] = [];
  for (let i = 0; i < lista.length; i += tamanho) saida.push(lista.slice(i, i + tamanho));
  return saida;
}

export async function lerTelaDeEmails(organizationId: string, agora: Date): Promise<TelaDeEmails> {
  const admin = createAdminClient();
  const [caixasR, listaR, filaR, conversasR] = await Promise.all([
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
      .gte("sent_at", new Date(agora.getTime() - DIAS_DA_LISTA * DIA_MS).toISOString())
      .order("sent_at", { ascending: false })
      .limit(TETO_DA_LISTA),
    admin
      .from("gmail_messages")
      .select(
        "id, mailbox_id, gmail_thread_id, direction, from_email, from_name, to_emails, cc_emails, subject, snippet, is_automated, sent_at, counterpart_email, contact_id",
      )
      .eq("organization_id", organizationId)
      .eq("is_automated", false)
      .gte("sent_at", new Date(agora.getTime() - DIAS_DA_FILA * DIA_MS).toISOString())
      .order("sent_at", { ascending: false })
      .limit(TETO_DA_FILA_DE_EMAIL),
    admin
      .from("conversations")
      .select(
        "id, channel, contact_id, status, comando_da_conversa, is_group, last_inbound_at, last_outbound_at, awaiting_since, " +
          "bot_silenced_until, assigned_to_user_id, last_message_preview, contacts(name, display_name, phone_number)",
      )
      .eq("organization_id", organizationId)
      .eq("is_group", false)
      .in("comando_da_conversa", ["aguardando", "ninguem", "humano"])
      .not("status", "in", `(${STATUS_ENCERRADOS_LISTA.join(",")})`)
      .order("awaiting_since", { ascending: true, nullsFirst: false })
      .limit(TETO_DAS_CONVERSAS),
  ]);

  const caixas = (caixasR.data ?? []) as CaixaNaTela[];
  const conversas = conversasDeEmail((listaR.data ?? []) as MensagemGuardada[]).filter((c) => !c.automatica);
  const nossas = new Set(caixas.map((c) => c.account_email.toLowerCase()));
  const daFila = (filaR.data ?? []) as MensagemDaFila[];
  const daConversa = (conversasR.data ?? []) as unknown as ConversaDaFila[];

  const fila: ItemDaFila[] = [
    ...emailsAguardandoResposta(daFila, nossas).map(
      (e): ItemDaFila => ({
        canal: "email",
        chave: `email:${e.contraparte}`,
        desde: e.desde,
        nome: e.nome || e.contraparte,
        assunto: e.assunto,
        trecho: e.trecho,
        mailbox_id: e.mailbox_id,
        gmail_thread_id: e.gmail_thread_id,
        contact_id: e.contact_id,
      }),
    ),
    ...daConversa
      .filter((c) => esperaUmaPessoa(c, agora))
      .map(
        (c): ItemDaFila => ({
          canal: "conversa",
          rede: c.channel,
          chave: `conversa:${c.id}`,
          desde: esperandoDesde(c) ?? c.last_inbound_at ?? agora.toISOString(),
          contato: c.contacts,
          trecho: c.last_message_preview,
          conversation_id: c.id,
          contact_id: c.contact_id,
        }),
      ),
  ].sort((a, b) => ms(a.desde) - ms(b.desde));

  const nomes = new Map<string, string>();
  const negocios = new Map<string, string>();
  let lookupsFalharam = false;
  const contatoIds = [...new Set([...conversas, ...fila].flatMap((c) => (c.contact_id ? [c.contact_id] : [])))];
  for (const lote of pedacos(contatoIds)) {
    const [{ data: contatos, error: e1 }, { data: leads, error: e2 }] = await Promise.all([
      admin.from("contacts").select("id, name, display_name").eq("organization_id", organizationId).in("id", lote),
      admin
        .from("crm_leads")
        .select("id, contact_id, updated_at")
        .eq("organization_id", organizationId)
        .eq("status", "open")
        .in("contact_id", lote)
        .order("updated_at", { ascending: false }),
    ]);
    if (e1 || e2) lookupsFalharam = true;
    for (const c of (contatos ?? []) as Array<{ id: string; name: string | null; display_name: string | null }>) {
      nomes.set(c.id, nomeDoContato(c) ?? "");
    }
    for (const l of (leads ?? []) as Array<{ id: string; contact_id: string }>) {
      if (!negocios.has(l.contact_id)) negocios.set(l.contact_id, l.id);
    }
  }

  return {
    caixas,
    conversas,
    fila,
    filaCortada: daFila.length >= TETO_DA_FILA_DE_EMAIL || daConversa.length >= TETO_DAS_CONVERSAS,
    filaFalhou: Boolean(caixasR.error || filaR.error || conversasR.error || lookupsFalharam),
    nomes,
    negocios,
  };
}
