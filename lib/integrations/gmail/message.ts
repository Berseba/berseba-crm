/**
 * Berseba: one Gmail API message (`users.messages.get`, format `full`) → the row of
 * `gmail_messages` (migration 9010). Pure: no network, no database, no clock.
 */

export interface GmailHeader {
  name?: string;
  value?: string;
}

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailApiMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

export interface Endereco {
  email: string;
  nome: string | null;
}

export interface EmailLido {
  gmail_message_id: string;
  gmail_thread_id: string;
  direction: "inbound" | "outbound";
  from_email: string;
  from_name: string | null;
  to_emails: string[];
  cc_emails: string[];
  subject: string | null;
  snippet: string | null;
  body_text: string | null;
  has_attachments: boolean;
  is_automated: boolean;
  sent_at: string;
  counterpart_email: string | null;
}

export const TETO_DO_CORPO = 20_000;

const EMAIL = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;

function cabecalho(headers: GmailHeader[] | undefined, nome: string): string | null {
  const alvo = nome.toLowerCase();
  const h = headers?.find((x) => x.name?.toLowerCase() === alvo);
  const v = h?.value?.trim();
  return v ? v : null;
}

/**
 * `"Ana Souza" <ana@x.com>, bob@y.com` → addresses, lower-cased. Commas inside quoted names do
 * not split; anything that is not an address is dropped.
 */
export function lerEnderecos(valor: string | null): Endereco[] {
  if (!valor) return [];
  const pedacos: string[] = [];
  let atual = "";
  let aspas = false;
  let angulo = false;
  for (const c of valor) {
    if (c === '"') aspas = !aspas;
    else if (c === "<") angulo = true;
    else if (c === ">") angulo = false;
    if (c === "," && !aspas && !angulo) {
      pedacos.push(atual);
      atual = "";
    } else {
      atual += c;
    }
  }
  pedacos.push(atual);
  const saida: Endereco[] = [];
  for (const pedaco of pedacos) {
    const p = pedaco.trim();
    if (!p) continue;
    const m = p.match(/^(.*)<([^>]+)>\s*$/);
    const email = (m ? m[2]! : p).trim().toLowerCase();
    if (!EMAIL.test(email)) continue;
    const nome = m ? m[1]!.trim().replace(/^"|"$/g, "").trim() : "";
    saida.push({ email, nome: nome || null });
  }
  return saida;
}

/** The part's charset (`Content-Type: text/plain; charset=ISO-8859-1`), else UTF-8. */
function charsetDa(parte: GmailPart): string {
  const tipo = cabecalho(parte.headers, "Content-Type") ?? "";
  const m = tipo.match(/charset\s*=\s*"?([A-Za-z0-9_.:-]+)"?/i);
  return m ? m[1]!.toLowerCase() : "utf-8";
}

/** Gmail hands the part's bytes base64url-encoded, in the part's own charset. */
function decodificar(parte: GmailPart): string {
  const data = parte.body?.data;
  if (!data) return "";
  const bytes = Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  try {
    return new TextDecoder(charsetDa(parte)).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function todasAsPartes(parte: GmailPart | undefined): GmailPart[] {
  if (!parte) return [];
  return [parte, ...(parte.parts ?? []).flatMap(todasAsPartes)];
}

/** HTML → readable text, good enough for a preview and for a classifier to read. */
export function textoDoHtml(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function corpo(payload: GmailPart | undefined): string | null {
  const partes = todasAsPartes(payload).filter((p) => !p.filename);
  const plano = partes.find((p) => p.mimeType === "text/plain" && p.body?.data);
  const html = partes.find((p) => p.mimeType === "text/html" && p.body?.data);
  const texto = plano ? decodificar(plano).trim() : html ? textoDoHtml(decodificar(html)) : "";
  if (!texto) return null;
  return texto.length > TETO_DO_CORPO ? texto.slice(0, TETO_DO_CORPO) : texto;
}

const REMETENTE_AUTOMATICO = /^(no-?reply|do-?not-?reply|nao-?responda|mailer-daemon|postmaster|notifications?|notificacoes?|bounce)[^@]*@/i;

function automatico(headers: GmailHeader[] | undefined, remetente: string): boolean {
  if (REMETENTE_AUTOMATICO.test(remetente)) return true;
  if (cabecalho(headers, "List-Unsubscribe") || cabecalho(headers, "List-Id")) return true;
  const precedence = cabecalho(headers, "Precedence")?.toLowerCase();
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") return true;
  const autoSubmitted = cabecalho(headers, "Auto-Submitted")?.toLowerCase();
  return Boolean(autoSubmitted && autoSubmitted !== "no");
}

function dominio(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

/** Public webmail: sharing the domain says nothing about being the same company. */
const WEBMAIL = /^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|me|aol|bol|uol|terra|ig|protonmail|proton)\.[a-z.]+$/;

/** Is this address outside the mailbox's company? */
export function deFora(email: string, contaDaCaixa: string): boolean {
  const conta = contaDaCaixa.trim().toLowerCase();
  const casa = dominio(conta);
  return WEBMAIL.test(casa) ? email !== conta : dominio(email) !== casa;
}

/**
 * The message as a row, or `null` when it has no id, no sender or no date, when it is a draft, or
 * when nobody outside the company is in it (mail between the partners is not a client's).
 */
export function lerEmail(msg: GmailApiMessage, contaDaCaixa: string): EmailLido | null {
  const id = msg.id?.trim();
  const thread = msg.threadId?.trim();
  const headers = msg.payload?.headers;
  const de = lerEnderecos(cabecalho(headers, "From"))[0];
  const quando = Number(msg.internalDate);
  if (!id || !thread || !de || !Number.isFinite(quando) || quando <= 0) return null;
  if ((msg.labelIds ?? []).includes("DRAFT")) return null;

  const conta = contaDaCaixa.trim().toLowerCase();
  const para = lerEnderecos(cabecalho(headers, "To")).map((e) => e.email);
  const copia = lerEnderecos(cabecalho(headers, "Cc")).map((e) => e.email);
  const enviada = (msg.labelIds ?? []).includes("SENT") || de.email === conta;

  // The person outside: the sender of an inbound; else (our own outbound, or a partner writing
  // with a client in To/Cc) the first outside recipient.
  const contraparte =
    !enviada && deFora(de.email, conta)
      ? de.email
      : ([...para, ...copia].find((e) => deFora(e, conta)) ?? null);
  if (!contraparte) return null;

  return {
    gmail_message_id: id,
    gmail_thread_id: thread,
    direction: enviada ? "outbound" : "inbound",
    from_email: de.email,
    from_name: de.nome,
    to_emails: para,
    cc_emails: copia,
    subject: cabecalho(headers, "Subject"),
    snippet: msg.snippet?.trim() || null,
    body_text: corpo(msg.payload),
    has_attachments: todasAsPartes(msg.payload).some((p) => Boolean(p.filename && p.body?.attachmentId)),
    is_automated: !enviada && deFora(de.email, conta) && automatico(headers, de.email),
    sent_at: new Date(quando).toISOString(),
    counterpart_email: contraparte,
  };
}

/**
 * The Gmail search for one time window: mail after `desde` minus one hour (the stored and the
 * skipped ids cover the overlap) and, when given, before `ate`; without chats, drafts, spam, trash
 * or the promotions/social/forums tabs.
 */
export function buscaDoGmail(desde: Date, ate?: Date): string {
  const depois = Math.floor((desde.getTime() - 60 * 60 * 1000) / 1000);
  const antes = ate ? ` before:${Math.ceil(ate.getTime() / 1000)}` : "";
  return `after:${depois}${antes} -in:chats -in:drafts -category:promotions -category:social -category:forums`;
}

/** Link to the thread in Gmail, in the mailbox's own account. */
export function linkDoGmail(contaDaCaixa: string, threadId: string): string {
  return `https://mail.google.com/mail/u/${encodeURIComponent(contaDaCaixa)}/#all/${encodeURIComponent(threadId)}`;
}
