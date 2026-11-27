/**
 * Berseba (#171, slice 4, migration 9012): every e-mail reaches the contact and the funnel.
 *
 * Runs after each Gmail read, over the e-mails not yet taken (`funil_em is null`), oldest first,
 * within the cron's shared deadline:
 *
 * 1. A person who wrote in (inbound, sent by the counterpart, not automated, not a no-reply
 *    address, never a connected mailbox nor a member of the organization) and is not a contact
 *    yet becomes one: name from the From header, e-mail, source `email`.
 * 2. The contact is resolved to the live one (a merged contact's winner; an anonymized contact
 *    gets nothing), and all e-mails of the address get it.
 * 3. A contact who wrote in within 14 days and has no open deal gets one, by upstream's own birth
 *    rules without a conversation: the client rules (`lerRegrasDeCliente`, agenda and sale,
 *    post-sale window), the funnel (`funilDeEntrada`, client funnel for a client), the guards
 *    (blocked, personal, internal or team tag), the title (`rotuloDoContato`), the RPC
 *    (`fn_nascer_lead_da_conversa`), the `lead_created` line and the `lead.created` event
 *    (automations, follow-ups, webhooks). Not applied: reopening a deal lost minutes ago
 *    (`reabrirPerdidoRecente` is bound to a conversation; it is opt-in per funnel).
 * 4. Every e-mail of a contact with an open deal is one timeline line (`email_received` /
 *    `email_sent`) inserted with the e-mail's own time, so the deal's and the contact's last
 *    activity follow the mail, not the read (a 14-day backfill does not make deals look active
 *    now). No message text in the line. One line per e-mail, ever.
 *
 * An e-mail is marked `funil_em` when its outcome was decided; a failed write leaves it for the
 * next run, at most `TENTATIVAS` times, and is logged. Never sends. Every chain filters by
 * `organization_id`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { lerRegrasDeCliente } from "@/lib/contacts/regras-de-cliente";
import { rotuloDoContato, SEM_NOME } from "@/lib/contacts/rotulo-do-contato";
import { ehContatoDaEquipe, lerTagsDaEquipe } from "@/lib/contacts/tags-da-equipe";
import { ehContatoInterno, lerTagsInternas } from "@/lib/contacts/tags-internas";
import { buildLeadActivityRow, emitLeadActivity } from "@/lib/leads/activity-emitter";
import { decidirPelaVenda, lerVendaAnterior } from "@/lib/leads/cliente-pela-venda";
import { funilDeEntrada } from "@/lib/leads/nascimento-do-lead";
import { logger } from "@/lib/logger";

/** E-mails taken per organization per run. */
export const TETO_DO_FUNIL = 100;
/** Failed writes on one e-mail before it is given up (and logged). */
export const TENTATIVAS = 3;
/** Older mail (the first 14-day backfill included) goes on the timeline but never opens a deal. */
const DIAS_PARA_ABRIR_NEGOCIO = 14;

const SEM_RESPOSTA =
  /(^|[._+-])(no-?reply|do-?not-?reply|nao-?responda|naoresponda|noreply)([._+-][^@]*)?@|^(mailer-daemon|postmaster|bounce[^@]*)@/i;

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
  funil_tentativas: number;
}

export interface ResultadoDoFunil {
  levados: number;
  contatosCriados: number;
  negociosAbertos: number;
  registrosNaTimeline: number;
  adiados: number;
}

/** Pure: did a person outside the organization write this e-mail in? */
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

/** The connected mailboxes and the organization's members: never a client. */
export async function enderecosDaCasa(admin: SupabaseClient, org: string): Promise<Set<string>> {
  const nossas = new Set<string>();
  const { data: caixas } = await admin.from("gmail_mailboxes").select("account_email").eq("organization_id", org);
  for (const c of (caixas ?? []) as Array<{ account_email: string }>) nossas.add(c.account_email.toLowerCase());
  const { data: membros } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", org)
    .is("revoked_at", null);
  for (const m of (membros ?? []) as Array<{ user_id: string }>) {
    const { data } = await admin.auth.admin.getUserById(m.user_id);
    const email = data?.user?.email?.trim().toLowerCase();
    if (email) nossas.add(email);
  }
  return nossas;
}

interface ContatoVivo {
  id: string;
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
  first_service_at: string | null;
  is_blocked: boolean;
  is_personal?: boolean;
  tags: string[] | null;
}

const COLUNAS_DO_CONTATO =
  "id, name, display_name, phone_number, first_service_at, is_blocked, is_personal, tags, is_merged_into, is_anonymized";

/** The live contact behind an id: a merged contact's winner; `null` when anonymized or gone. */
async function contatoVivo(admin: SupabaseClient, org: string, id: string): Promise<ContatoVivo | null> {
  let atual = id;
  for (let i = 0; i < 3; i++) {
    const { data } = await admin.from("contacts").select(COLUNAS_DO_CONTATO).eq("organization_id", org).eq("id", atual).maybeSingle();
    const c = data as (ContatoVivo & { is_merged_into: string | null; is_anonymized: boolean }) | null;
    if (!c || c.is_anonymized) return null;
    if (!c.is_merged_into) return c;
    atual = c.is_merged_into;
  }
  return null;
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
  // Created meanwhile (unique e-mail per organization): use that one. Any other refusal (e.g. an
  // address the format check refuses) leaves the e-mail without a contact, which is decided.
  return contatoPorEmail(admin, org, email);
}

async function podeAbrirNegocio(admin: SupabaseClient, org: string, c: ContatoVivo): Promise<boolean> {
  if (c.is_blocked || c.is_personal) return false;
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

type Nascimento = { ok: true; leadId: string | null } | { ok: false; erro: string };

/** Upstream's birth rules for a conversation, applied to an e-mail (see the header). */
async function abrirNegocio(admin: SupabaseClient, org: string, c: ContatoVivo, e: EmailParaOFunil): Promise<Nascimento> {
  const regras = await lerRegrasDeCliente(admin, org);
  const venda = regras.pelaVenda ? await lerVendaAnterior(admin, org, c.id) : null;
  const pelaVenda = decidirPelaVenda({ pelaVenda: regras.pelaVenda, posVendaDias: regras.posVendaDias, venda });
  if (pelaVenda.posVenda) return { ok: true, leadId: null };
  const ehCliente = (c.first_service_at != null && regras.pelaAgenda) || pelaVenda.cliente;

  const destino = await funilDeEntrada(admin, org, ehCliente);
  if ("erro" in destino) return { ok: false, erro: `funil: ${destino.erro}` };

  const doCadastro = rotuloDoContato(c);
  const titulo = doCadastro !== SEM_NOME ? doCadastro : (nomeDoRemetente(e) ?? "Novo contato pelo e-mail");
  const { data: id, error } = await admin.rpc("fn_nascer_lead_da_conversa", {
    p_org: org,
    p_contact: c.id,
    p_pipeline: destino.pipelineId,
    p_stage: destino.stageId,
    p_title: titulo,
    p_source: "email",
    p_source_metadata: {},
    p_tags: [],
  } as never);
  if (error) return { ok: false, erro: `nascer: ${error.message}` };
  // `null`: another writer opened one meanwhile (the RPC holds the contact's lock).
  if (!id) return { ok: true, leadId: await negocioAberto(admin, org, c.id) };
  const leadId = id as string;

  await emitLeadActivity(admin, {
    organizationId: org,
    leadId,
    contactId: c.id,
    type: "lead_created",
    sourceModule: "gmail",
    sourceId: e.id,
    actor: { type: "webhook_source", id: "gmail-intake" },
    reason: pelaVenda.cliente && pelaVenda.motivo ? pelaVenda.motivo : ehCliente ? "cliente conhecido voltou a escrever" : "escreveu por e-mail",
    payload: { origem: "email", cliente: ehCliente },
  });
  // What the trigger no longer emits on insert: automations, follow-ups and webhooks listen to it.
  const { error: erroEvento } = await admin.rpc("emit_event", {
    p_event_type: "lead.created",
    p_entity_kind: "crm_lead",
    p_entity_id: leadId,
    p_payload: { pipeline_id: destino.pipelineId, stage_id: destino.stageId, origem: "email" },
    p_metadata: { source: "nascimento-do-email" },
    p_organization_id: org,
  } as never);
  if (erroEvento) logger.warn("gmail_funil: lead.created not emitted", { organization_id: org, lead_id: leadId, error: erroEvento.message });
  return { ok: true, leadId };
}

/** One line per e-mail, with the e-mail's own time (the activity trigger moves "last activity"). */
async function registrarNaTimeline(
  admin: SupabaseClient,
  org: string,
  leadId: string,
  contactId: string,
  e: EmailParaOFunil,
): Promise<"novo" | "ja_existia" | "falhou"> {
  const tipo = e.direction === "inbound" ? "email_received" : "email_sent";
  const { data: existe } = await admin
    .from("crm_lead_activities")
    .select("id")
    .eq("organization_id", org)
    .eq("lead_id", leadId)
    .eq("source_module", "gmail")
    .eq("source_id", e.id)
    .eq("type", tipo)
    .limit(1)
    .maybeSingle();
  if (existe) return "ja_existia";
  const linha = buildLeadActivityRow({
    organizationId: org,
    leadId,
    contactId,
    type: tipo,
    sourceModule: "gmail",
    sourceId: e.id,
    actor: { type: "webhook_source", id: "gmail-intake" },
    reason: e.direction === "inbound" ? "e-mail recebido" : "e-mail enviado",
    payload: { gmail_message_id: e.id, mailbox_id: e.mailbox_id },
  });
  const { error } = await admin.from("crm_lead_activities").insert({ ...linha, performed_at: new Date(e.sent_at).toISOString() });
  return error ? "falhou" : "novo";
}

export async function levarEmailsAoFunil(
  admin: SupabaseClient,
  org: string,
  nossas: ReadonlySet<string>,
  agora: Date,
  prazo: number = Date.now() + 30_000,
  relogio: () => number = Date.now,
): Promise<ResultadoDoFunil> {
  const resultado: ResultadoDoFunil = { levados: 0, contatosCriados: 0, negociosAbertos: 0, registrosNaTimeline: 0, adiados: 0 };
  const { data, error } = await admin
    .from("gmail_messages")
    .select("id, mailbox_id, direction, from_email, from_name, counterpart_email, contact_id, is_automated, sent_at, funil_tentativas")
    .eq("organization_id", org)
    .is("funil_em", null)
    .order("sent_at", { ascending: true })
    .limit(TETO_DO_FUNIL);
  if (error) throw new Error(`gmail_funil: ${error.message}`);
  const emails = (data ?? []) as EmailParaOFunil[];
  const limiteDoNegocio = agora.getTime() - DIAS_PARA_ABRIR_NEGOCIO * 24 * 60 * 60 * 1000;
  // Within one run, the same address resolves (and relinks) once.
  const contatoDoEndereco = new Map<string, string | null>();

  for (const e of emails) {
    if (relogio() > prazo) break;
    const falhas: string[] = [];
    const doCliente = escritoPeloCliente(e, nossas);
    const endereco = e.counterpart_email;
    let contactId = e.contact_id;

    if (!contactId && endereco && !nossas.has(endereco)) {
      if (!contatoDoEndereco.has(endereco)) {
        let id = await contatoPorEmail(admin, org, endereco);
        if (!id && doCliente) {
          id = await criarContato(admin, org, e);
          if (id) resultado.contatosCriados += 1;
        }
        if (id) {
          const { error: erro } = await admin
            .from("gmail_messages")
            .update({ contact_id: id })
            .eq("organization_id", org)
            .eq("counterpart_email", endereco)
            .is("contact_id", null);
          if (erro) falhas.push(`religar: ${erro.message}`);
        }
        contatoDoEndereco.set(endereco, id);
      }
      contactId = contatoDoEndereco.get(endereco) ?? null;
    }

    const contato = contactId && !e.is_automated && !nossas.has(endereco ?? "") ? await contatoVivo(admin, org, contactId) : null;
    if (contato) {
      if (contato.id !== contactId) {
        // A merge left the e-mail on the losing contact: it follows the winner.
        await admin.from("gmail_messages").update({ contact_id: contato.id }).eq("organization_id", org).eq("id", e.id);
      }
      let leadId = await negocioAberto(admin, org, contato.id);
      if (!leadId && doCliente && Date.parse(e.sent_at) >= limiteDoNegocio && (await podeAbrirNegocio(admin, org, contato))) {
        const n = await abrirNegocio(admin, org, contato, e);
        if (!n.ok) falhas.push(n.erro);
        else if (n.leadId) {
          leadId = n.leadId;
          resultado.negociosAbertos += 1;
        }
      }
      if (leadId) {
        const r = await registrarNaTimeline(admin, org, leadId, contato.id, e);
        if (r === "falhou") falhas.push("timeline");
        if (r === "novo") resultado.registrosNaTimeline += 1;
      }
      await admin
        .from("contacts")
        .update({ last_activity_at: new Date(e.sent_at).toISOString() })
        .eq("organization_id", org)
        .eq("id", contato.id)
        .or(`last_activity_at.is.null,last_activity_at.lt.${new Date(e.sent_at).toISOString()}`);
    }

    const tentativas = (e.funil_tentativas ?? 0) + (falhas.length > 0 ? 1 : 0);
    if (falhas.length > 0) {
      logger.warn("gmail_funil: e-mail not fully taken", { organization_id: org, gmail_message_id: e.id, tentativas, falhas });
    }
    const decidido = falhas.length === 0 || tentativas >= TENTATIVAS;
    await admin
      .from("gmail_messages")
      .update(decidido ? { funil_em: agora.toISOString(), funil_tentativas: tentativas } : { funil_tentativas: tentativas })
      .eq("organization_id", org)
      .eq("id", e.id);
    if (decidido) resultado.levados += 1;
    else resultado.adiados += 1;
  }
  return resultado;
}
