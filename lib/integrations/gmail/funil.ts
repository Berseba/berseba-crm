/**
 * Berseba (#171, slice 4, migration 9012): every e-mail reaches the contact and the funnel.
 *
 * Runs after each Gmail read, over the e-mails not yet taken (`funil_em is null`), oldest first:
 *
 * 1. A person who wrote in (inbound, sent by the counterpart, not automated, not a no-reply
 *    address) and is not a contact yet becomes one: name from the From header, e-mail, source
 *    `email`. The connected mailboxes are never turned into contacts.
 * 2. Their e-mails get the contact (all of them, by address).
 * 3. A contact who wrote in and has no open deal gets one in the organization's entry funnel —
 *    the same rule and RPC as a new WhatsApp conversation (`funilDeEntrada`,
 *    `fn_nascer_lead_da_conversa`), and the same guards (blocked, personal, internal or team tag).
 * 4. Every e-mail of a contact with an open deal goes on its timeline (`email_received` /
 *    `email_sent`; no text of the message in the entry: the timeline reason is not a place for
 *    personal data) and moves the contact's `last_activity_at` forward.
 *
 * Each e-mail is marked `funil_em` whatever the outcome, so nothing is taken twice. Never sends.
 * Every chain filters by `organization_id`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ehContatoDaEquipe, lerTagsDaEquipe } from "@/lib/contacts/tags-da-equipe";
import { ehContatoInterno, lerTagsInternas } from "@/lib/contacts/tags-internas";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { funilDeEntrada } from "@/lib/leads/nascimento-do-lead";

/** E-mails taken per organization per run. */
export const TETO_DO_FUNIL = 200;
/** Older mail (the first 14-day backfill included) goes on the timeline but never opens a deal. */
const DIAS_PARA_ABRIR_NEGOCIO = 14;

const SEM_RESPOSTA = /^(no-?reply|do-?not-?reply|nao-?responda|mailer-daemon|postmaster|bounce)[^@]*@/i;

export interface EmailParaOFunil {
  id: string;
  mailbox_id: string;
  direction: "inbound" | "outbound";
  from_email: string;
  from_name: string | null;
  counterpart_email: string | null;
  contact_id: string | null;
  is_automated: boolean;
  sent_at: string;
}

export interface ResultadoDoFunil {
  levados: number;
  contatosCriados: number;
  negociosAbertos: number;
  registrosNaTimeline: number;
}

/** Pure: did a person (not a robot, not us) write this e-mail in? */
export function escritoPeloCliente(e: EmailParaOFunil, nossas: ReadonlySet<string>): boolean {
  return (
    e.direction === "inbound" &&
    !e.is_automated &&
    e.counterpart_email !== null &&
    e.from_email === e.counterpart_email &&
    !nossas.has(e.from_email) &&
    !SEM_RESPOSTA.test(e.from_email)
  );
}

/** Pure: the contact's name from the From header, never the address itself. */
export function nomeDoRemetente(e: EmailParaOFunil): string | null {
  const nome = e.from_name?.replace(/\s+/g, " ").trim() ?? "";
  if (!nome || nome.includes("@") || nome.length > 120) return null;
  return nome;
}

async function contatoPorEmail(admin: SupabaseClient, org: string, email: string): Promise<string | null> {
  const { data } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", org)
    .eq("email_normalized", email)
    .is("is_merged_into", null)
    .eq("is_anonymized", false)
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function criarContato(admin: SupabaseClient, org: string, e: EmailParaOFunil): Promise<string | null> {
  const email = e.counterpart_email!;
  const { data, error } = await admin
    .from("contacts")
    .insert({ organization_id: org, name: nomeDoRemetente(e), email, source: "email" })
    .select("id")
    .maybeSingle();
  if (!error && data) return (data as { id: string }).id;
  // Created meanwhile (unique e-mail per organization): use that one.
  return contatoPorEmail(admin, org, email);
}

/** The guards of `garantirLeadDaConversa`: who never opens a deal. */
async function podeAbrirNegocio(admin: SupabaseClient, org: string, contactId: string): Promise<boolean> {
  const { data } = await admin
    .from("contacts")
    .select("is_blocked, is_personal, tags")
    .eq("organization_id", org)
    .eq("id", contactId)
    .maybeSingle();
  const c = data as { is_blocked?: boolean; is_personal?: boolean; tags?: string[] } | null;
  if (!c || c.is_blocked || c.is_personal) return false;
  const tags = c.tags ?? [];
  if (tags.length === 0) return true;
  if (ehContatoInterno(tags, await lerTagsInternas(admin, org))) return false;
  return !ehContatoDaEquipe(tags, await lerTagsDaEquipe(admin, org));
}

async function negocioAberto(admin: SupabaseClient, org: string, contactId: string): Promise<string | null> {
  const { data } = await admin
    .from("crm_leads")
    .select("id")
    .eq("organization_id", org)
    .eq("contact_id", contactId)
    .eq("status", "open")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function abrirNegocio(
  admin: SupabaseClient,
  org: string,
  contactId: string,
  titulo: string,
  emailId: string,
): Promise<string | null> {
  const destino = await funilDeEntrada(admin, org, false);
  if ("erro" in destino) return null;
  const { data: id, error } = await admin.rpc("fn_nascer_lead_da_conversa", {
    p_org: org,
    p_contact: contactId,
    p_pipeline: destino.pipelineId,
    p_stage: destino.stageId,
    p_title: titulo,
    p_source: "email",
    p_source_metadata: {},
    p_tags: [],
  } as never);
  if (error || !id) return null;
  await emitLeadActivity(admin, {
    organizationId: org,
    leadId: id as string,
    contactId,
    type: "lead_created",
    sourceModule: "gmail",
    sourceId: emailId,
    actor: { type: "webhook_source", id: "gmail-intake" },
    reason: "escreveu por e-mail",
    payload: { origem: "email" },
  });
  return id as string;
}

export async function levarEmailsAoFunil(
  admin: SupabaseClient,
  org: string,
  nossas: ReadonlySet<string>,
  agora: Date,
): Promise<ResultadoDoFunil> {
  const resultado: ResultadoDoFunil = { levados: 0, contatosCriados: 0, negociosAbertos: 0, registrosNaTimeline: 0 };
  const { data, error } = await admin
    .from("gmail_messages")
    .select("id, mailbox_id, direction, from_email, from_name, counterpart_email, contact_id, is_automated, sent_at")
    .eq("organization_id", org)
    .is("funil_em", null)
    .order("sent_at", { ascending: true })
    .limit(TETO_DO_FUNIL);
  if (error) throw new Error(`gmail_funil: ${error.message}`);
  const emails = (data ?? []) as EmailParaOFunil[];
  const limiteDoNegocio = agora.getTime() - DIAS_PARA_ABRIR_NEGOCIO * 24 * 60 * 60 * 1000;
  // Within one run, the same address resolves once.
  const contatoDoEndereco = new Map<string, string | null>();

  for (const e of emails) {
    const doCliente = escritoPeloCliente(e, nossas);
    let contactId = e.contact_id;

    if (!contactId && e.counterpart_email && !nossas.has(e.counterpart_email)) {
      if (!contatoDoEndereco.has(e.counterpart_email)) {
        let id = await contatoPorEmail(admin, org, e.counterpart_email);
        if (!id && doCliente) {
          id = await criarContato(admin, org, e);
          if (id) resultado.contatosCriados += 1;
        }
        contatoDoEndereco.set(e.counterpart_email, id);
      }
      contactId = contatoDoEndereco.get(e.counterpart_email) ?? null;
      if (contactId) {
        await admin
          .from("gmail_messages")
          .update({ contact_id: contactId })
          .eq("organization_id", org)
          .eq("counterpart_email", e.counterpart_email)
          .is("contact_id", null);
      }
    }

    if (contactId && !e.is_automated) {
      let leadId = await negocioAberto(admin, org, contactId);
      if (!leadId && doCliente && Date.parse(e.sent_at) >= limiteDoNegocio && (await podeAbrirNegocio(admin, org, contactId))) {
        const titulo = nomeDoRemetente(e) ?? e.counterpart_email ?? "Novo contato por e-mail";
        leadId = await abrirNegocio(admin, org, contactId, titulo, e.id);
        if (leadId) resultado.negociosAbertos += 1;
      }
      if (leadId) {
        const r = await emitLeadActivity(admin, {
          organizationId: org,
          leadId,
          contactId,
          type: e.direction === "inbound" ? "email_received" : "email_sent",
          sourceModule: "gmail",
          sourceId: e.id,
          actor: { type: "webhook_source", id: "gmail-intake" },
          reason: e.direction === "inbound" ? "e-mail recebido" : "e-mail enviado",
          payload: { gmail_message_id: e.id, mailbox_id: e.mailbox_id, sent_at: e.sent_at },
        });
        if (r.ok) {
          resultado.registrosNaTimeline += 1;
          // The line shows when the e-mail was sent, not when the CRM read it (the helper always
          // writes "now"; a late read would put the e-mails out of order on the timeline).
          await admin
            .from("crm_lead_activities")
            .update({ performed_at: new Date(e.sent_at).toISOString() })
            .eq("organization_id", org)
            .eq("lead_id", leadId)
            .eq("source_module", "gmail")
            .eq("source_id", e.id);
        }
      }
      await admin
        .from("contacts")
        .update({ last_activity_at: e.sent_at })
        .eq("organization_id", org)
        .eq("id", contactId)
        .or(`last_activity_at.is.null,last_activity_at.lt.${new Date(e.sent_at).toISOString()}`);
    }

    await admin.from("gmail_messages").update({ funil_em: agora.toISOString() }).eq("organization_id", org).eq("id", e.id);
    resultado.levados += 1;
  }
  return resultado;
}
