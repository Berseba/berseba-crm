/**
 * Berseba (#171, slice 3): one meeting-detection round for one organization.
 *
 * Reads the last `JANELA_DIAS` days of client messages — inbound e-mails from the counterpart
 * (`gmail_messages`, not automated) and inbound 1:1 WhatsApp text/audio (`messages`, not revoked,
 * never a group) — leaves out the ones already read (`meeting_proposals` has one row per message
 * the model saw), keeps only those that talk about meeting (`falaDeReuniao`, so most text never
 * leaves the server), and asks the organization's model (`runModelCall`: its default model, its
 * budget, its `llm_calls` row) at most `TETO_DE_CHAMADAS` times. Every answer becomes a row:
 * `proposta` with the time and a short excerpt, or `nenhuma` with no text. Never books anything.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { renderAgora, rotuloLocal } from "@/lib/tempo/agora";

import { falaDeReuniao, lerResposta, semCitacao, trechoDa, type Proposta } from "./deteccao";

export const JANELA_DIAS = 3;
/** Model calls per organization per round (every 5 minutes). */
export const TETO_DE_CHAMADAS = 20;
/** Consecutive failed calls that mean the provider is down: the round stops. */
const FALHAS_SEGUIDAS = 3;
/** `nenhuma` rows only guard the 3-day window; every row goes after 90 days. */
const PODA_NENHUMA_DIAS = 7;
const PODA_DIAS = 90;
const TETO_DE_LEITURA = 300;

export interface Candidata {
  source: "email" | "whatsapp";
  source_id: string;
  contact_id: string | null;
  owner_user_id: string | null;
  texto: string;
  sent_at: string;
}

/** The model call, injected (the cron passes `runModelCall`; tests pass a fake). */
export type Classificar = (texto: string, sistema: string) => Promise<unknown>;

/** The organization's AI budget refused the call: nothing more this round. */
export function ehRecusaDeOrcamento(erro: unknown): boolean {
  return erro instanceof Error && (erro.name === "LlmBudgetExceededError" || /budget|orçamento/i.test(erro.message));
}

export interface ResultadoDaRodada {
  lidas: number;
  classificadas: number;
  propostas: number;
  erro?: string;
}

/** Pure: which candidates go to the model this round — new, talking about meeting, oldest first. */
export function escolherCandidatas(todas: Candidata[], jaLidas: ReadonlySet<string>, teto = TETO_DE_CHAMADAS): Candidata[] {
  return todas
    .filter((c) => !jaLidas.has(`${c.source}:${c.source_id}`) && falaDeReuniao(c.texto))
    .sort((a, b) => (a.sent_at < b.sent_at ? -1 : 1))
    .slice(0, teto);
}

async function candidatasDoEmail(admin: SupabaseClient, org: string, desde: string): Promise<Candidata[]> {
  const { data, error } = await admin
    .from("gmail_messages")
    .select("id, contact_id, from_email, counterpart_email, subject, body_text, snippet, sent_at, gmail_mailboxes!inner(user_id)")
    .eq("organization_id", org)
    .eq("direction", "inbound")
    .eq("is_automated", false)
    .gte("sent_at", desde)
    .order("sent_at", { ascending: false })
    .limit(TETO_DE_LEITURA);
  if (error) throw new Error(`meeting_detection: e-mails: ${error.message}`);
  return ((data ?? []) as unknown as Array<{
    id: string;
    contact_id: string | null;
    from_email: string;
    counterpart_email: string | null;
    subject: string | null;
    body_text: string | null;
    snippet: string | null;
    sent_at: string;
    gmail_mailboxes: { user_id: string } | null;
  }>)
    .filter((m) => m.from_email === m.counterpart_email)
    .map((m) => ({
      source: "email" as const,
      source_id: m.id,
      contact_id: m.contact_id,
      owner_user_id: m.gmail_mailboxes?.user_id ?? null,
      texto: [m.subject ? `Assunto: ${m.subject}` : "", semCitacao(m.body_text || m.snippet || "")].filter(Boolean).join("\n"),
      sent_at: m.sent_at,
    }));
}

async function candidatasDoWhatsapp(admin: SupabaseClient, org: string, desde: string): Promise<Candidata[]> {
  const { data, error } = await admin
    .from("messages")
    .select("id, contact_id, body, media_derived_text, sent_at, conversations!inner(is_group, assigned_to_user_id)")
    .eq("organization_id", org)
    .eq("direction", "inbound")
    .in("type", ["text", "audio"])
    .is("revoked_at", null)
    .eq("conversations.is_group", false)
    .gte("sent_at", desde)
    .order("sent_at", { ascending: false })
    .limit(TETO_DE_LEITURA);
  if (error) throw new Error(`meeting_detection: whatsapp: ${error.message}`);
  return ((data ?? []) as unknown as Array<{
    id: string;
    contact_id: string | null;
    body: string | null;
    media_derived_text: string | null;
    sent_at: string;
    conversations: { is_group: boolean; assigned_to_user_id: string | null } | null;
  }>)
    .filter((m) => m.conversations && !m.conversations.is_group)
    .map((m) => ({
      source: "whatsapp" as const,
      source_id: m.id,
      contact_id: m.contact_id,
      owner_user_id: m.conversations?.assigned_to_user_id ?? null,
      texto: m.body || m.media_derived_text || "",
      sent_at: m.sent_at,
    }))
    .filter((m) => m.texto.trim() !== "");
}

async function jaLidas(admin: SupabaseClient, org: string, candidatas: Candidata[]): Promise<Set<string>> {
  const lidas = new Set<string>();
  for (const source of ["email", "whatsapp"] as const) {
    const ids = candidatas.filter((c) => c.source === source).map((c) => c.source_id);
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await admin
        .from("meeting_proposals")
        .select("source_id")
        .eq("organization_id", org)
        .eq("source", source)
        .in("source_id", ids.slice(i, i + 100));
      if (error) throw new Error(`meeting_detection: lidas: ${error.message}`);
      for (const r of (data ?? []) as Array<{ source_id: string }>) lidas.add(`${source}:${r.source_id}`);
    }
  }
  return lidas;
}

/** Pure: the row stored for one classified message. */
export function linhaDaProposta(org: string, c: Candidata, p: Proposta) {
  const nenhuma = p.intent === "nenhuma";
  return {
    organization_id: org,
    source: c.source,
    source_id: c.source_id,
    contact_id: c.contact_id,
    owner_user_id: c.owner_user_id,
    intent: p.intent,
    status: nenhuma ? "nenhuma" : "proposta",
    starts_at: nenhuma ? null : p.starts_at,
    duration_minutes: nenhuma ? null : p.duration_minutes,
    title: nenhuma ? null : p.title,
    excerpt: nenhuma ? null : trechoDa(c.texto),
  };
}

export async function rodadaDeReunioes(
  admin: SupabaseClient,
  org: string,
  fuso: string,
  agora: Date,
  classificar: Classificar,
  sistema: string,
  prazo: number = Date.now() + 90_000,
  relogio: () => number = Date.now,
): Promise<ResultadoDaRodada> {
  await admin
    .from("meeting_proposals")
    .delete()
    .eq("organization_id", org)
    .eq("status", "nenhuma")
    .lt("created_at", new Date(agora.getTime() - PODA_NENHUMA_DIAS * 24 * 60 * 60 * 1000).toISOString());
  await admin
    .from("meeting_proposals")
    .delete()
    .eq("organization_id", org)
    .lt("created_at", new Date(agora.getTime() - PODA_DIAS * 24 * 60 * 60 * 1000).toISOString());

  const desde = new Date(agora.getTime() - JANELA_DIAS * 24 * 60 * 60 * 1000).toISOString();
  const todas = [...(await candidatasDoEmail(admin, org, desde)), ...(await candidatasDoWhatsapp(admin, org, desde))];
  const escolhidas = escolherCandidatas(todas, await jaLidas(admin, org, todas));
  const sistemaComAgora = `${sistema}\n\n${renderAgora(agora, fuso)}`;

  let classificadas = 0;
  let propostas = 0;
  let falhasSeguidas = 0;
  let ultimoErro: string | undefined;
  for (const c of escolhidas) {
    if (relogio() > prazo) break;
    let bruto: unknown;
    try {
      const enviada = `Enviada em: ${rotuloLocal(new Date(c.sent_at), fuso)}`;
      bruto = await classificar(`${enviada}\n\n${c.texto.slice(0, 2000)}`, sistemaComAgora);
      falhasSeguidas = 0;
    } catch (erro) {
      ultimoErro = erro instanceof Error ? erro.message : String(erro);
      // Budget refused, or the provider is down: stop and try next round (nothing stored).
      if (ehRecusaDeOrcamento(erro)) return { lidas: todas.length, classificadas, propostas, erro: ultimoErro };
      falhasSeguidas += 1;
      if (falhasSeguidas >= FALHAS_SEGUIDAS) return { lidas: todas.length, classificadas, propostas, erro: ultimoErro };
      // One message the provider refuses never blocks the others: skip it this round.
      continue;
    }
    // An answer that is not the tool's shape counts as "nothing found": stored, never re-sent
    // (otherwise the same messages would be paid for every 5 minutes).
    const p = lerResposta(bruto, agora) ?? { intent: "nenhuma" as const, starts_at: null, duration_minutes: null, title: null };
    const { error } = await admin
      .from("meeting_proposals")
      .upsert(linhaDaProposta(org, c, p), { onConflict: "organization_id,source,source_id", ignoreDuplicates: true });
    if (error) return { lidas: todas.length, classificadas, propostas, erro: `gravar: ${error.message}` };
    classificadas += 1;
    if (p.intent !== "nenhuma") propostas += 1;
  }
  return { lidas: todas.length, classificadas, propostas, ...(ultimoErro ? { erro: ultimoErro } : {}) };
}
