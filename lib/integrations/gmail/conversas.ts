/**
 * Berseba: the e-mail screen's grouping (migration 9010). Pure: stored messages → one line per
 * thread of a mailbox, the newest message on top.
 */

export interface MensagemGuardada {
  id: string;
  mailbox_id: string;
  gmail_thread_id: string;
  direction: "inbound" | "outbound";
  from_email: string;
  from_name: string | null;
  subject: string | null;
  snippet: string | null;
  is_automated: boolean;
  sent_at: string;
  counterpart_email: string | null;
  contact_id: string | null;
}

export interface ConversaDeEmail {
  chave: string;
  mailbox_id: string;
  gmail_thread_id: string;
  /** `null` when the e-mail has no subject (the screen renders the translated placeholder). */
  assunto: string | null;
  trecho: string | null;
  contraparte: string | null;
  nomeDaContraparte: string | null;
  contact_id: string | null;
  ultimaEm: string;
  ultimaDirecao: "inbound" | "outbound";
  mensagens: number;
  automatica: boolean;
}

/** `messages` sorted newest first (as the screen queries them). */
export function conversasDeEmail(mensagens: MensagemGuardada[]): ConversaDeEmail[] {
  const porChave = new Map<string, ConversaDeEmail>();
  for (const m of mensagens) {
    const chave = `${m.mailbox_id}:${m.gmail_thread_id}`;
    const c = porChave.get(chave);
    if (c) {
      c.mensagens += 1;
      c.contact_id ??= m.contact_id;
      c.contraparte ??= m.counterpart_email;
      if (!c.nomeDaContraparte && m.direction === "inbound") c.nomeDaContraparte = m.from_name;
      if (!m.is_automated) c.automatica = false;
      continue;
    }
    porChave.set(chave, {
      chave,
      mailbox_id: m.mailbox_id,
      gmail_thread_id: m.gmail_thread_id,
      assunto: m.subject?.trim() || null,
      trecho: m.snippet,
      contraparte: m.counterpart_email,
      nomeDaContraparte: m.direction === "inbound" ? m.from_name : null,
      contact_id: m.contact_id,
      ultimaEm: m.sent_at,
      ultimaDirecao: m.direction,
      mensagens: 1,
      automatica: m.is_automated,
    });
  }
  return [...porChave.values()];
}
