/**
 * Berseba (#171, slice 2): which clients still owe a reply by e-mail. Pure.
 *
 * One item per client ADDRESS (the same e-mail lands once in each partner's mailbox, under a
 * different thread id; listing both would show it twice). A client waits when, in some thread,
 * their own message (inbound, sent by them, not automated) came after everything we wrote in that
 * thread, and nobody wrote to that address afterwards from ANY connected mailbox, as recipient or
 * copy, in any thread. The connected mailboxes are always "us": a partner's message is never a
 * client waiting, whatever the domain. The wait starts at the client's first message after our
 * last one, the same reading as the inbox's `esperandoDesde`; the oldest wait wins.
 */
import type { MensagemGuardada } from "./conversas";

export interface MensagemDaFila extends MensagemGuardada {
  to_emails: string[];
  cc_emails: string[];
}

export interface EmailAguardando {
  mailbox_id: string;
  gmail_thread_id: string;
  desde: string;
  contraparte: string;
  nome: string | null;
  /** `null` when the e-mail has no subject (the screen renders the translated placeholder). */
  assunto: string | null;
  trecho: string | null;
  contact_id: string | null;
}

const ms = (iso: string) => Date.parse(iso);

/** `mensagens` in any order; `nossas` = the connected mailboxes' addresses. Oldest wait first. */
export function emailsAguardandoResposta(mensagens: MensagemDaFila[], nossas: ReadonlySet<string>): EmailAguardando[] {
  const ehNossa = (e: string | null | undefined) => Boolean(e && nossas.has(e.toLowerCase()));
  const doCliente = (m: MensagemDaFila) =>
    m.direction === "inbound" &&
    !m.is_automated &&
    m.counterpart_email !== null &&
    m.from_email === m.counterpart_email &&
    !ehNossa(m.from_email);
  const escritaPorNos = (m: MensagemDaFila) => m.direction === "outbound" || ehNossa(m.from_email);

  // The last time we wrote to each outside address, from any mailbox, in any thread.
  const ultimaNossa = new Map<string, number>();
  for (const m of mensagens) {
    if (!escritaPorNos(m)) continue;
    for (const e of [m.counterpart_email, ...m.to_emails, ...m.cc_emails]) {
      if (!e || ehNossa(e)) continue;
      const t = ms(m.sent_at);
      if ((ultimaNossa.get(e) ?? Number.NEGATIVE_INFINITY) < t) ultimaNossa.set(e, t);
    }
  }

  const porConversa = new Map<string, MensagemDaFila[]>();
  for (const m of mensagens) {
    if (m.is_automated && !escritaPorNos(m)) continue;
    const chave = `${m.mailbox_id}:${m.gmail_thread_id}`;
    const lista = porConversa.get(chave);
    if (lista) lista.push(m);
    else porConversa.set(chave, [m]);
  }

  const porCliente = new Map<string, EmailAguardando>();
  for (const lista of porConversa.values()) {
    const ordem = [...lista].sort((a, b) => ms(a.sent_at) - ms(b.sent_at));
    const ultima = ordem[ordem.length - 1];
    if (!ultima || !doCliente(ultima)) continue;
    const contraparte = ultima.counterpart_email!;
    if ((ultimaNossa.get(contraparte) ?? Number.NEGATIVE_INFINITY) >= ms(ultima.sent_at)) continue;
    let desde = ultima;
    for (let i = ordem.length - 1; i >= 0; i--) {
      const m = ordem[i]!;
      if (escritaPorNos(m)) break;
      if (doCliente(m)) desde = m;
    }
    const item: EmailAguardando = {
      mailbox_id: ultima.mailbox_id,
      gmail_thread_id: ultima.gmail_thread_id,
      desde: desde.sent_at,
      contraparte,
      nome: ultima.from_name,
      assunto: ultima.subject?.trim() || null,
      trecho: ultima.snippet,
      contact_id: ordem.find((m) => m.contact_id)?.contact_id ?? null,
    };
    const atual = porCliente.get(contraparte);
    if (!atual || ms(item.desde) < ms(atual.desde)) porCliente.set(contraparte, item);
  }
  return [...porCliente.values()].sort((a, b) => ms(a.desde) - ms(b.desde));
}
