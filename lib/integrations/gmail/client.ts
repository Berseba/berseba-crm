/**
 * Berseba: the three Gmail API reads the intake needs. Read-only, never throws: every call
 * answers `{ok: false, status, erro}` on a network failure or a refusal.
 */

import type { GmailApiMessage } from "./message";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const PRAZO_MS = 10_000;

export type GmailFetch = typeof fetch;

export type Resposta<T> = { ok: true; dados: T } | { ok: false; status: number | null; erro: string };

async function ler<T>(caminho: string, accessToken: string, f: GmailFetch): Promise<Resposta<T>> {
  let r: Response;
  try {
    r = await f(`${BASE}${caminho}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(PRAZO_MS),
      cache: "no-store",
    });
  } catch (e) {
    return { ok: false, status: null, erro: e instanceof Error ? e.message : String(e) };
  }
  if (!r.ok) {
    const corpo = await r.text().catch(() => "");
    return { ok: false, status: r.status, erro: corpo.slice(0, 300) || `HTTP ${r.status}` };
  }
  try {
    return { ok: true, dados: (await r.json()) as T };
  } catch {
    return { ok: false, status: r.status, erro: "corpo ilegível" };
  }
}

/** The connected account's address (works with `gmail.readonly`). */
export async function perfilDoGmail(accessToken: string, f: GmailFetch = fetch): Promise<Resposta<{ emailAddress?: string }>> {
  return ler("/profile", accessToken, f);
}

/**
 * Message ids matching `q`, newest first, at most `teto` (pages of up to 500). `truncada` = Gmail
 * had more: the caller narrows the window instead of losing the older ones.
 */
export async function idsDasMensagens(
  accessToken: string,
  q: string,
  teto: number,
  f: GmailFetch = fetch,
): Promise<Resposta<{ ids: string[]; truncada: boolean }>> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const p = new URLSearchParams({ q, maxResults: String(Math.min(500, teto)) });
    if (pageToken) p.set("pageToken", pageToken);
    const r = await ler<{ messages?: Array<{ id?: string }>; nextPageToken?: string }>(`/messages?${p}`, accessToken, f);
    if (!r.ok) return r;
    for (const m of r.dados.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = r.dados.nextPageToken;
  } while (pageToken && ids.length < teto);
  return { ok: true, dados: { ids: ids.slice(0, teto), truncada: Boolean(pageToken) || ids.length > teto } };
}

export async function mensagemDoGmail(accessToken: string, id: string, f: GmailFetch = fetch): Promise<Resposta<GmailApiMessage>> {
  return ler(`/messages/${encodeURIComponent(id)}?format=full`, accessToken, f);
}
