/**
 * MODO SOMBRA — o cinto de segurança ACIMA do agente.
 *
 * ─── Por que este módulo existe ─────────────────────────────────────────────
 *
 * O produto já tem o mecanismo POR AGENTE: `ai_agents.operation_mode =
 * 'assisted'` faz o turno gerar um rascunho (`ai_reply_drafts`, status
 * `pending`) em vez de enviar. Isso é uma escolha de configuração — o dono
 * decide, agente por agente, qual comportamento ele quer.
 *
 * O modo sombra é outra coisa: um interruptor ACIMA disso, que a clínica liga
 * quando quer ter certeza — mesmo que alguém tenha deixado um agente em
 * `automatic` por engano, mesmo que um canal novo herde configuração errada —
 * de que NENHUMA mensagem gerada por IA sai para o WhatsApp sem um humano
 * aprovar antes. É o "não confio, mas quero testar" que vale para a
 * organização inteira ou para um canal, não para um agente de cada vez.
 *
 * ─── A regra é pura ─────────────────────────────────────────────────────────
 *
 * `decidirModoSombra` não toca banco: recebe três booleanos já lidos (o
 * interruptor da organização, o do canal, e se o AGENTE resolvido para este
 * turno já está em `operation_mode = 'assisted'`) e devolve `sombra` (OR dos
 * três) + `origem` (qual foi o primeiro a estar ligado, para o log e a
 * tarja do inbox saberem o que contar). Dobrar o "já sou assistido" para
 * dentro desta função — em vez de o chamador fazer
 * `agentConfig?.operationMode === 'assisted' || sombra.sombra` por conta
 * própria — é o que mantém o hook no `inbound-turn.ts` em poucas linhas: um
 * lugar só decide "este turno se comporta como assistido?", e a resposta
 * serve tanto para quem já era assistido antes deste módulo existir quanto
 * para quem acabou de ligar o cinto na organização ou no canal.
 *
 * Regra: QUALQUER um ligado = sombra. Nenhuma combinação desliga a outra.
 */

export interface EstadoDeModoSombra {
  /** `organizations.settings->'modo_sombra'` já normalizado. */
  org: boolean;
  /** `channel_sessions.metadata->'modo_sombra'` já normalizado. */
  canal: boolean;
  /**
   * O agente resolvido para este turno já está em `operation_mode =
   * 'assisted'`? Dobrado aqui para que o chamador tenha UM lugar só que
   * responde "este turno se comporta como assistido" — não dois.
   */
  agente: boolean;
}

export type OrigemDoModoSombra = "organizacao" | "canal" | "agente" | null;

export interface DecisaoDeModoSombra {
  sombra: boolean;
  origem: OrigemDoModoSombra;
}

/**
 * OR dos três — a origem é a primeira, na ordem organização → canal → agente,
 * que estiver ligada. A ordem importa só para o log/tarja (qual motivo
 * mostrar quando mais de um está ligado ao mesmo tempo); a decisão de
 * bloquear é a mesma não importa qual apareça primeiro.
 */
export function decidirModoSombra(e: EstadoDeModoSombra): DecisaoDeModoSombra {
  if (e.org) return { sombra: true, origem: "organizacao" };
  if (e.canal) return { sombra: true, origem: "canal" };
  if (e.agente) return { sombra: true, origem: "agente" };
  return { sombra: false, origem: null };
}
