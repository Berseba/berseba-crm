/**
 * Berseba: one intake run over a connected Gmail (migration 9010).
 *
 * Renews the token when due, then walks forward from `synced_until` in time windows: each window
 * is listed whole (narrowed when Gmail has more than `TETO_DA_LISTA` in it, so nothing older is
 * lost), its new ids are read oldest first (at most `TETO_POR_RODADA` per run, within
 * `PRAZO_DE_LEITURA_MS`), mail with an outside party is stored linked to the contact, and every
 * other id read (internal mail, drafts) is remembered in `gmail_skipped_messages`, so no id is ever
 * read twice and the mark always moves. What was read before a failure is kept. Then relinks
 * stored e-mails whose contact was created since. Every chain filters by `organization_id`.
 * Never sends anything.
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
/** Ids listed per window; more than this narrows the window. */
const TETO_DA_LISTA = 500;
/** At the one-hour minimum the window cannot narrow any more: the list pages this far instead. */
const TETO_DA_LISTA_NA_MENOR_JANELA = 5000;
const HORA_MS = 60 * 60 * 1000;
const JANELA_MAXIMA_MS = 7 * 24 * HORA_MS;
const JANELAS_POR_RODADA = 20;
/**
 * The scheduler gives the cron 120 s. Gmail calls stop once this much has gone (one deadline for
 * the whole run, every mailbox) and the rest goes to the next run; the database writes after it
 * are quick.
 */
export const PRAZO_DE_LEITURA_MS = 60_000;
/** Skipped ids older than this are never listed again (the mark only moves forward). */
const PODA_DAS_IGNORADAS_DIAS = 45;

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
  if (teto <= 0) return { ler: [], restam: novos.length > 0 };
  const ler = novos.slice(-teto).reverse();
  return { ler, restam: novos.length > ler.length };
}

/**
 * Pure: the next `synced_until` after one window `[.., ate)`. Complete (every listed id known or
 * read, the list not cut) → the window's end, never past now; otherwise → the newest message read
 * (everything older in the window was read first). Never moves back.
 */
export function proximoMarco(
  atual: string | null,
  ate: Date,
  agora: Date,
  lidosEm: number[],
  completa: boolean,
): string | null {
  const candidato = completa
    ? Math.min(ate.getTime(), agora.getTime())
    : lidosEm.length > 0
      ? Math.max(...lidosEm)
      : null;
  if (candidato === null) return atual;
  const atualMs = atual ? new Date(atual).getTime() : Number.NEGATIVE_INFINITY;
  return new Date(Math.max(atualMs, candidato)).toISOString();
}

/** Pure: the window to list next, halved when Gmail cut the list, never under one hour. */
export function proximaJanela(janelaMs: number, truncada: boolean): number {
  return truncada ? Math.max(HORA_MS, Math.floor(janelaMs / 2)) : janelaMs;
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

/** Ids already stored or skipped in this mailbox. */
async function conhecidos(admin: SupabaseClient, caixa: CaixaDoGmail, ids: string[]): Promise<Set<string>> {
  const existem = new Set<string>();
  for (const tabela of ["gmail_messages", "gmail_skipped_messages"] as const) {
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await admin
        .from(tabela)
        .select("gmail_message_id")
        .eq("organization_id", caixa.organization_id)
        .eq("mailbox_id", caixa.id)
        .in("gmail_message_id", ids.slice(i, i + 100));
      if (error) throw new Error(`gmail_intake: ${tabela}: ${error.message}`);
      for (const r of (data ?? []) as Array<{ gmail_message_id: string }>) existem.add(r.gmail_message_id);
    }
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
  relogio: () => number = Date.now,
  /** Absolute deadline (ms) for this mailbox's Gmail calls; the cron shares one across mailboxes. */
  prazo: number = relogio() + PRAZO_DE_LEITURA_MS,
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

  let desde = caixa.synced_until
    ? new Date(caixa.synced_until)
    : new Date(agora.getTime() - JANELA_INICIAL_DIAS * 24 * HORA_MS);
  let janelaMs = JANELA_MAXIMA_MS;
  let tetoDaLista = TETO_DA_LISTA;
  let marco = caixa.synced_until;
  let status: ResultadoDaCaixa["status"] = "healthy";
  let erro: string | undefined;
  let renovar = false;
  let restam = false;
  let lidas = 0;
  const lidos: EmailLido[] = [];
  const ignoradas: string[] = [];

  for (let n = 0; n < JANELAS_POR_RODADA; n++) {
    if (relogio() > prazo) {
      restam = true;
      break;
    }
    const ate = new Date(Math.min(desde.getTime() + janelaMs, agora.getTime()));
    const lista = await idsDasMensagens(a.accessToken, buscaDoGmail(desde, ate), tetoDaLista, f);
    if (!lista.ok) {
      status = statusDaRecusa(lista.status, lista.erro);
      erro = lista.erro;
      renovar = lista.status === 401;
      restam = true;
      break;
    }
    const { ids, truncada } = lista.dados;
    if (truncada && janelaMs > HORA_MS) {
      // More than the list holds: narrow the window and list again, so nothing older is lost.
      janelaMs = proximaJanela(janelaMs, true);
      continue;
    }
    if (truncada && tetoDaLista < TETO_DA_LISTA_NA_MENOR_JANELA) {
      // Even one hour holds more than 500: page through the whole hour, oldest included.
      tetoDaLista = TETO_DA_LISTA_NA_MENOR_JANELA;
      continue;
    }

    const { ler, restam: sobra } = escolherDaRodada(ids, await conhecidos(admin, caixa, ids), TETO_POR_RODADA - lidas);
    const lidosEm: number[] = [];
    let parou = sobra;
    for (const id of ler) {
      if (relogio() > prazo) {
        parou = true;
        break;
      }
      const m = await mensagemDoGmail(a.accessToken, id, f);
      if (!m.ok) {
        // Gone between the list and the read: never listed again.
        if (m.status === 404) continue;
        status = statusDaRecusa(m.status, m.erro);
        erro = m.erro;
        renovar = m.status === 401;
        parou = true;
        break;
      }
      lidas += 1;
      const quando = Number(m.dados.internalDate);
      if (Number.isFinite(quando) && quando > 0) lidosEm.push(quando);
      const e = lerEmail(m.dados, caixa.account_email);
      if (e) lidos.push(e);
      else ignoradas.push(id);
    }

    const completa = !parou && !truncada;
    marco = proximoMarco(marco, ate, agora, lidosEm, completa);
    if (!completa || ate.getTime() >= agora.getTime() || lidas >= TETO_POR_RODADA) {
      restam = !completa || ate.getTime() < agora.getTime();
      break;
    }
    desde = ate;
  }

  // What was read is kept even when the run stopped early. The mark is written only after it.
  if (ignoradas.length > 0) {
    const { error } = await admin.from("gmail_skipped_messages").upsert(
      ignoradas.map((gmail_message_id) => ({
        organization_id: caixa.organization_id,
        mailbox_id: caixa.id,
        gmail_message_id,
      })),
      { onConflict: "mailbox_id,gmail_message_id", ignoreDuplicates: true },
    );
    if (error) return fim({ ...base, lidas, status, erro: `ignoradas: ${error.message}` });
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
    if (error) return fim({ ...base, lidas, status, erro: `gravar: ${error.message}` });
    gravadas = data?.length ?? 0;
  }

  await admin
    .from("gmail_skipped_messages")
    .delete()
    .eq("organization_id", caixa.organization_id)
    .eq("mailbox_id", caixa.id)
    .eq("motivo", "ignorada")
    .lt("created_at", new Date(agora.getTime() - PODA_DAS_IGNORADAS_DIAS * 24 * HORA_MS).toISOString());

  const religadas = await religar(admin, caixa.organization_id);
  return fim({ caixa: caixa.id, status, lidas, gravadas, religadas, restam, erro }, marco, renovar);
}
