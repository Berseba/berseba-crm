/**
 * Berseba: who wrote each outbound message in the agent's conversation history.
 *
 * The history (`getLeadContext`) carried only `direction`, so every outbound
 * reached the model as its own speech (`"direction":"outbound"`, or `de: 'nós'`
 * in the projection), whether the agent wrote it (`sent_via = 'ai'`), a person
 * sent it from the CRM (`'user'`/`'crm'`), someone typed it on the phone
 * (`'external_device'`), or an automation sent it (`'automation'`/`'system'`).
 *
 * At Studio Bruno Alves (audit of 2026-11-04) the team sends payment links,
 * renewal offers and birthday messages from the same number the agent answers.
 * 206 of 406 AI reply bursts happened in conversations the team was already
 * handling, and the agent carried on the team's plan-renewal campaign ("qual
 * das opções de plano fica melhor pra você?") as if it were its own.
 *
 * The fix is in what the model knows, not in who it answers: every outbound
 * carries its author. Only `'ai'` is the agent's own speech; an unknown or
 * missing value is read as the team, because claiming authorship the row does
 * not prove is the defect this file exists to close.
 */

/** Who wrote an outbound message, as the raw context shows it. */
export type OutboundAuthor = "agent" | "team" | "automation";

export function outboundAuthor(sentVia: string | null | undefined): OutboundAuthor {
  if (sentVia === "ai") return "agent";
  if (sentVia === "automation" || sentVia === "system") return "automation";
  return "team";
}

/** The same author in the projection's vocabulary (`MensagemProjetada.de`). */
export const OUTBOUND_AUTHOR_LABEL = {
  agent: "você",
  team: "equipe",
  automation: "automação",
} as const satisfies Record<OutboundAuthor, string>;

export type OutboundAuthorLabel = (typeof OUTBOUND_AUTHOR_LABEL)[OutboundAuthor];

/**
 * The line that tells the model how to read the authors, right under the
 * history heading. One wording per format, because the projected and the raw
 * context name the field differently, and the one-line history
 * (`LEAD_CONTEXT_HISTORY_FORMAT=linhas`) has no field name at all.
 */
export function historyAuthorshipNote(projected: boolean, lines = false): string {
  const labels =
    '"cliente" é o contato; "você" é mensagem que você mesmo enviou; ' +
    '"equipe" é uma pessoa da equipe (pelo CRM ou pelo celular); "automação" é envio automático (lembrete, campanha, aviso).';
  const who = lines
    ? `Em cada linha, o rótulo depois da hora diz quem escreveu: ${labels}`
    : projected
      ? `Em cada mensagem, \`de\` diz quem escreveu: ${labels}`
      : 'Em cada mensagem, `direction: "inbound"` é o contato; nas `outbound`, `author` diz quem escreveu: ' +
        '"agent" é você mesmo; "team" é uma pessoa da equipe (pelo CRM ou pelo celular); "automation" é envio automático (lembrete, campanha, aviso).';
  // Upstream's "Quem disse o quê" block (AUTORIA_SYSTEM_BLOCK) calls the
  // company's speech `de: "nós"`; here that label is split in three.
  const nos = lines || projected ? 'As três ("você", "equipe" e "automação") são o `de: "nós"` de "Quem disse o quê": fala da empresa. ' : "";
  return (
    `(${who} ${nos}` +
    "Só as mensagens marcadas como suas foram escritas por você. O que a equipe ou a automação escreveu o cliente já leu: " +
    "não repita, e não trate a oferta, a cobrança ou o combinado delas como se fossem seus.)"
  );
}
