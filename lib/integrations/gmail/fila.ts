/**
 * Berseba (#171, slice 2): which e-mail threads still owe the client a reply. Pure.
 *
 * A thread of a mailbox waits when its newest message is the client's own (inbound, sent by the
 * counterpart, not automated) and nobody wrote to that address afterwards from ANY connected
 * mailbox: a partner answering from the other inbox, or in another thread, settles it. The wait
 * starts at the client's first message after our last one in that thread, the same reading as
 * the inbox's `esperandoDesde` for WhatsApp.
 */
import type { MensagemGuardada } from "./conversas";

export interface EmailAguardando {
  mailbox_id: string;
  gmail_thread_id: string;
  desde: string;
  contraparte: string;
  nome: string | null;
  assunto: string;
  trecho: string | null;
  contact_id: string | null;
}

const doCliente = (m: MensagemGuardada) =>
  m.direction === "inbound" && !m.is_automated && m.counterpart_email !== null && m.from_email === m.counterpart_email;

/** `mensagens` in any order; the result is oldest wait first. */
export function emailsAguardandoResposta(mensagens: MensagemGuardada[]): EmailAguardando[] {
  // The last time we wrote to each address, from any mailbox, in any thread.
  const ultimaNossa = new Map<string, string>();
  for (const m of mensagens) {
    if (m.direction !== "outbound" || !m.counterpart_email) continue;
    const atual = ultimaNossa.get(m.counterpart_email);
    if (!atual || m.sent_at > atual) ultimaNossa.set(m.counterpart_email, m.sent_at);
  }

  const porConversa = new Map<string, MensagemGuardada[]>();
  for (const m of mensagens) {
    const chave = `${m.mailbox_id}:${m.gmail_thread_id}`;
    const lista = porConversa.get(chave);
    if (lista) lista.push(m);
    else porConversa.set(chave, [m]);
  }

  const fila: EmailAguardando[] = [];
  for (const lista of porConversa.values()) {
    const ordem = [...lista].filter((m) => !m.is_automated || m.direction === "outbound").sort((a, b) => (a.sent_at < b.sent_at ? -1 : 1));
    const ultima = ordem[ordem.length - 1];
    if (!ultima || !doCliente(ultima)) continue;
    const contraparte = ultima.counterpart_email!;
    const nossa = ultimaNossa.get(contraparte);
    if (nossa && nossa >= ultima.sent_at) continue;
    // First message of the client after our last one in this thread (or the first ever).
    let desde = ultima;
    for (let i = ordem.length - 1; i >= 0; i--) {
      const m = ordem[i]!;
      if (m.direction === "outbound") break;
      if (doCliente(m)) desde = m;
    }
    fila.push({
      mailbox_id: ultima.mailbox_id,
      gmail_thread_id: ultima.gmail_thread_id,
      desde: desde.sent_at,
      contraparte,
      nome: ultima.from_name,
      assunto: ultima.subject?.trim() || "(sem assunto)",
      trecho: ultima.snippet,
      contact_id: ordem.find((m) => m.contact_id)?.contact_id ?? null,
    });
  }
  return fila.sort((a, b) => (a.desde < b.desde ? -1 : 1));
}
