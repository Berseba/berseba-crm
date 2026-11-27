/**
 * Berseba: one intake run over a connected Gmail (migration 9010).
 *
 * Renews the token when due, asks Gmail for the mail after `synced_until` (minus one hour), reads
 * the new ones oldest first (at most `TETO_POR_RODADA` per run), links each to the contact whose
 * e-mail is the counterpart, and stores them. Then relinks stored e-mails whose contact was
 * created since. Every chain filters by `organization_id`. Never sends anything.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { fundirTokens, precisaRenovar, type TokenDoGoogle } from "@/lib/agenda/google/oauth";
import { renovarToken } from "@/lib/agenda/google/token";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";

import { idsDasMensagens, mensagemDoGmail, type GmailFetch } from "./client";
import type { AppDoGmail } from "./config";
import { buscaDoGmail, lerEmail, type EmailLido } from "./message";

/** First run reads this far back. */
export const JANELA_INICIAL_DIAS = 14;
/** Messages read per mailbox per run (one Gmail call each). */
export const TETO_POR_RODADA = 50;
/** Ids listed per run. */
const TETO_DA_LISTA = 500;

export interface CaixaDoGmail {
  id: string;
  organization_id: string;
  account_email: string;
  oauth_access_token_encrypted: string | null;
  oauth_refresh_token_encrypted: string | null;
  token_expires_at: string | null;
  scopes: string[] | null;
  synced_until: string | null;
}

export const COLUNAS_DA_CAIXA =
  "id, organization_id, account_email, oauth_access_token_encrypted, oauth_refresh_token_encrypted, token_expires_at, scopes, synced_until";

export interface ResultadoDaCaixa {
  caixa: string;
  status: "healthy" | "token_expired" | "scope_missing" | "error";
  lidas: number;
  gravadas: number;
  religadas: number;
  restam: boolean;
  erro?: string;
}

/** Pure: which of the listed ids to read this run. Gmail lists newest first; read oldest first. */
export function escolherDaRodada(listados: string[], jaGuardados: ReadonlySet<string>, teto = TETO_POR_RODADA): {
  ler: string[];
  restam: boolean;
} {
  const novos = listados.filter((id) => !jaGuardados.has(id));
  const ler = novos.slice(-teto).reverse();
  return { ler, restam: novos.length > ler.length };
}

/** Pure: the next `synced_until`. Caught up → now; capped → the newest message read. */
export function proximoMarco(atual: string | null, lidos: EmailLido[], restam: boolean, agora: Date): string | null {
  if (!restam) return agora.toISOString();
  const maisNovo = lidos.reduce<string | null>((m, e) => (m === null || e.sent_at > m ? e.sent_at : m), null);
  if (!maisNovo) return atual;
  return atual && atual > maisNovo ? atual : maisNovo;
}

async function contatosPorEmail(admin: SupabaseClient, org: string, emails: string[]): Promise<Map<string, string>> {
  const mapa = new Map<string, string>();
  const unicos = [...new Set(emails)];
  for (let i = 0; i < unicos.length; i += 100) {
    const { data, error } = await admin
      .from("contacts")
      .select("id, email_normalized, last_activity_at")
      .eq("organization_id", org)
      .in("email_normalized", unicos.slice(i, i + 100))
      .is("is_merged_into", null)
      .eq("is_anonymized", false)
      .order("last_activity_at", { ascending: false, nullsFirst: false });
    if (error) throw new Error(`gmail_intake: contatos: ${error.message}`);
    for (const c of (data ?? []) as Array<{ id: string; email_normalized: string | null }>) {
      if (c.email_normalized && !mapa.has(c.email_normalized)) mapa.set(c.email_normalized, c.id);
    }
  }
  return mapa;
}

async function guardados(admin: SupabaseClient, caixa: CaixaDoGmail, ids: string[]): Promise<Set<string>> {
  const existem = new Set<string>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await admin
      .from("gmail_messages")
      .select("gmail_message_id")
      .eq("organization_id", caixa.organization_id)
      .eq("mailbox_id", caixa.id)
      .in("gmail_message_id", ids.slice(i, i + 100));
    if (error) throw new Error(`gmail_intake: guardados: ${error.message}`);
    for (const r of (data ?? []) as Array<{ gmail_message_id: string }>) existem.add(r.gmail_message_id);
  }
  return existem;
}

/** E-mails stored without a contact whose counterpart is now a contact get linked. */
async function religar(admin: SupabaseClient, org: string): Promise<number> {
  const { data, error } = await admin
    .from("gmail_messages")
    .select("counterpart_email")
    .eq("organization_id", org)
    .is("contact_id", null)
    .not("counterpart_email", "is", null)
    .order("sent_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`gmail_intake: sem contato: ${error.message}`);
  const emails = [...new Set(((data ?? []) as Array<{ counterpart_email: string }>).map((r) => r.counterpart_email))];
  if (emails.length === 0) return 0;
  const contatos = await contatosPorEmail(admin, org, emails);
  let religadas = 0;
  for (const [email, contactId] of contatos) {
    const { data: feitas, error: erro } = await admin
      .from("gmail_messages")
      .update({ contact_id: contactId })
      .eq("organization_id", org)
      .eq("counterpart_email", email)
      .is("contact_id", null)
      .select("id");
    if (erro) throw new Error(`gmail_intake: religar: ${erro.message}`);
    religadas += feitas?.length ?? 0;
  }
  return religadas;
}

type Acesso = { ok: true; accessToken: string } | { ok: false; status: ResultadoDaCaixa["status"]; erro: string };

async function acesso(admin: SupabaseClient, app: AppDoGmail, caixa: CaixaDoGmail, agora: Date): Promise<Acesso> {
  if (caixa.oauth_access_token_encrypted && !precisaRenovar(caixa.token_expires_at, agora)) {
    const token = await decryptWebhookSecret(admin, caixa.oauth_access_token_encrypted);
    if (token) return { ok: true, accessToken: token };
  }
  const refresh = caixa.oauth_refresh_token_encrypted
    ? await decryptWebhookSecret(admin, caixa.oauth_refresh_token_encrypted)
    : null;
  if (!refresh) return { ok: false, status: "token_expired", erro: "sem refresh token: reconecte o Gmail" };
  const leitura = await renovarToken(app, refresh, { agora });
  if (!leitura.ok) {
    // Only a revoked grant needs the partner; anything else (network, 5xx) is tried next run.
    const revogado = leitura.motivo === "erro_do_google" && /invalid_grant/.test(leitura.detalhe);
    return { ok: false, status: revogado ? "token_expired" : "healthy", erro: leitura.detalhe };
  }
  const anterior: TokenDoGoogle = {
    access_token: "",
    refresh_token: refresh,
    scope: caixa.scopes ?? [],
    token_type: "Bearer",
    expira_em: agora.toISOString(),
  };
  const token = fundirTokens(anterior, leitura.token);
  const cifrado = await encryptWebhookSecret(admin, token.access_token);
  if (cifrado) {
    await admin
      .from("gmail_mailboxes")
      .update({ oauth_access_token_encrypted: cifrado, token_expires_at: token.expira_em, scopes: token.scope })
      .eq("organization_id", caixa.organization_id)
      .eq("id", caixa.id);
  }
  return { ok: true, accessToken: token.access_token };
}

/**
 * A refusal while reading. Only a missing scope needs the partner; everything else stays
 * `healthy` (the cron only reads healthy mailboxes, so `error` would stop the intake for good
 * after one network blip). A 401 also drops the token's validity, so the next run renews it, and
 * a revoked grant then shows up as `token_expired` from the renewal.
 */
function statusDaRecusa(status: number | null, erro: string): ResultadoDaCaixa["status"] {
  if (status === 403 && /insufficient|scope/i.test(erro)) return "scope_missing";
  return "healthy";
}

export async function lerCaixa(
  admin: SupabaseClient,
  app: AppDoGmail,
  caixa: CaixaDoGmail,
  agora: Date,
  f: GmailFetch = fetch,
): Promise<ResultadoDaCaixa> {
  const base = { caixa: caixa.id, lidas: 0, gravadas: 0, religadas: 0, restam: false };
  const fim = async (r: ResultadoDaCaixa, marco?: string | null, renovar = false): Promise<ResultadoDaCaixa> => {
    await admin
      .from("gmail_mailboxes")
      .update({
        status: r.status,
        last_sync_at: agora.toISOString(),
        last_sync_error: r.erro ? r.erro.slice(0, 500) : null,
        ...(marco !== undefined ? { synced_until: marco } : {}),
        ...(renovar ? { token_expires_at: null } : {}),
      })
      .eq("organization_id", caixa.organization_id)
      .eq("id", caixa.id);
    return r;
  };

  const a = await acesso(admin, app, caixa, agora);
  if (!a.ok) return fim({ ...base, status: a.status, erro: a.erro });

  const desde = caixa.synced_until
    ? new Date(caixa.synced_until)
    : new Date(agora.getTime() - JANELA_INICIAL_DIAS * 24 * 60 * 60 * 1000);
  const lista = await idsDasMensagens(a.accessToken, buscaDoGmail(desde), TETO_DA_LISTA, f);
  if (!lista.ok) {
    return fim({ ...base, status: statusDaRecusa(lista.status, lista.erro), erro: lista.erro }, undefined, lista.status === 401);
  }

  const { ler, restam } = escolherDaRodada(lista.dados, await guardados(admin, caixa, lista.dados));
  const lidos: EmailLido[] = [];
  for (const id of ler) {
    const m = await mensagemDoGmail(a.accessToken, id, f);
    if (!m.ok) {
      // A message gone between the list and the read (deleted) is skipped; anything else stops
      // the run here, and the next run starts again from the same mark.
      if (m.status === 404) continue;
      return fim(
        { ...base, lidas: lidos.length, status: statusDaRecusa(m.status, m.erro), erro: m.erro },
        undefined,
        m.status === 401,
      );
    }
    const e = lerEmail(m.dados, caixa.account_email);
    if (e) lidos.push(e);
  }

  const contatos = await contatosPorEmail(
    admin,
    caixa.organization_id,
    lidos.flatMap((e) => (e.counterpart_email ? [e.counterpart_email] : [])),
  );
  let gravadas = 0;
  if (lidos.length > 0) {
    const linhas = lidos.map((e) => ({
      ...e,
      organization_id: caixa.organization_id,
      mailbox_id: caixa.id,
      contact_id: (e.counterpart_email && contatos.get(e.counterpart_email)) || null,
    }));
    const { data, error } = await admin
      .from("gmail_messages")
      .upsert(linhas, { onConflict: "mailbox_id,gmail_message_id", ignoreDuplicates: true })
      .select("id");
    if (error) return fim({ ...base, lidas: lidos.length, status: "healthy", erro: `gravar: ${error.message}` });
    gravadas = data?.length ?? 0;
  }

  const religadas = await religar(admin, caixa.organization_id);
  return fim(
    { caixa: caixa.id, status: "healthy", lidas: ler.length, gravadas, religadas, restam },
    proximoMarco(caixa.synced_until, lidos, restam, agora),
  );
}
