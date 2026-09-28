/**
 * AGENDA EXTERNA — contrato de quem sabe responder "tem vaga?" fora daqui.
 *
 * POR QUE ISTO EXISTE, E POR QUE NÃO SE CHAMA `adminfit`.
 * --------------------------------------------------------------------------
 * O primeiro caso real é um studio de treino funcional cuja grade de turmas
 * vive num sistema de terceiro (Admin Fit). O agente precisa saber se a turma
 * de quinta às 7h tem vaga ANTES de oferecer o horário — oferecer e não ter é
 * pior do que não oferecer.
 *
 * A tentação era uma tool `adminfit_vagas`. Ela resolveria UM cliente e
 * envenenaria a instalação inteira: numa instalação multi-organização, cada
 * conector de cliente vira código que TODOS carregam, e o `update.sh` sobe
 * todos juntos. Com quatro clientes e quatro conectores nesse formato, um bug
 * em qualquer um derruba os quatro.
 *
 * Então o que entra no produto é a CAPACIDADE — "consultar a grade de um
 * sistema externo" — e o sistema de cada cliente é um adaptador por trás dela.
 * O segundo e o terceiro cliente reaproveitam a tool, a tela e o guardrail;
 * só escrevem o adaptador deles.
 *
 * ⚠️ SÓ LEITURA, E ISSO NÃO É DETALHE. Nada neste módulo escreve no sistema do
 * cliente. O sistema do studio guarda restrição física de aluno — dado de
 * saúde — e uma escrita nossa lá dentro seria responsabilidade que não
 * pedimos e não sabemos honrar. A reserva vive do nosso lado; a confirmação
 * na grade dele é ato humano.
 *
 * ⚠️ MODALIDADE É OBRIGATÓRIA. Não é zelo de tipagem: a mesma sala comporta
 * 16 pessoas no funcional e 7 no personalizado, então "vaga" sem modalidade
 * não quer dizer nada. E a grade do cliente mistura turmas infantis e de dança
 * com as de adulto — perguntar "o que tem quinta às 16h" e devolver a turma
 * de Kids para quem quer funcional é o erro que a dona do negócio pediu, por
 * nome, que não acontecesse.
 */

/** Identificador do sistema externo. Cresce com um adaptador por entrada. */
export type ProvedorDeAgendaExterna = "adminfit";

/**
 * Modalidade na linguagem do CRM, não na do sistema externo.
 *
 * O adaptador é quem traduz para o vocabulário de lá. Se este tipo carregasse
 * o nome do outro sistema, trocar de fornecedor viraria migração de dado.
 */
export interface ModalidadeExterna {
  /** Chave estável usada pelo funil e pela consulta. Ex: `funcional`. */
  chave: string;
  /** Como a pessoa chama. Ex: "Novum Funcional". */
  rotulo: string;
}

/** Um horário da grade, já resolvido para uma modalidade. */
export interface VagaExterna {
  /** Dia no fuso da organização, `YYYY-MM-DD`. */
  dia: string;
  /** `HH:mm`, 24h. */
  hora: string;
  modalidade: ModalidadeExterna;
  /**
   * Quantas vagas sobraram. `0` é resposta legítima e significa turma cheia —
   * diferente de `null`, que significa que o sistema externo não informou.
   * Quem consome não pode tratar os dois igual: `0` fecha a oferta, `null`
   * exige confirmação humana.
   */
  vagasLivres: number | null;
  /** Capacidade total, quando o sistema externo informa. */
  capacidade: number | null;
  /** Rótulo do professor/turma, quando houver. Só para exibição. */
  turma: string | null;
}

/**
 * Resultado de uma consulta.
 *
 * ⚠️ FALHA É UM ESTADO DE PRIMEIRA CLASSE, não uma exceção. Um agente no meio
 * de uma conversa com um cliente precisa distinguir três coisas:
 *
 *   `ok`            → a grade respondeu; ofereça o que veio
 *   `indisponivel`  → não conseguimos falar com o sistema; NÃO invente horário,
 *                     diga que vai confirmar
 *   `nao_configurado` → esta organização não tem agenda externa; a agenda de
 *                     casa é a fonte, e a tool não deveria nem ter sido chamada
 *
 * Lançar exceção nos dois últimos empurraria o modelo para o comportamento
 * errado: diante de um erro cru, ele tende a seguir a conversa com um horário
 * plausível e inventado. Um estado nomeado, com instrução dentro, não tem essa
 * ambiguidade.
 */
export type ConsultaDeVagas =
  | { situacao: "ok"; vagas: ReadonlyArray<VagaExterna>; consultadoEm: string }
  | { situacao: "indisponivel"; motivo: string }
  | { situacao: "nao_configurado" };

/** O que o CRM pergunta a um sistema externo. */
export interface PerguntaDeVagas {
  /** Chave da modalidade. Obrigatória — ver o aviso no topo do arquivo. */
  modalidade: string;
  /** Primeiro dia do intervalo, `YYYY-MM-DD` no fuso da organização. */
  de: string;
  /** Último dia, inclusive. */
  ate: string;
}

/**
 * O adaptador de cada sistema externo.
 *
 * Uma função só, de propósito: tudo que o produto precisa é "responda vagas
 * neste intervalo". Adaptador que precisar de mais superfície está tentando
 * escrever no sistema do cliente, e isso não é caso de uso deste módulo.
 */
export interface AdaptadorDeAgendaExterna {
  provedor: ProvedorDeAgendaExterna;
  /** Modalidades que este adaptador sabe consultar, já na chave do CRM. */
  modalidades: ReadonlyArray<ModalidadeExterna>;
  consultar(pergunta: PerguntaDeVagas): Promise<ConsultaDeVagas>;
}

/**
 * Configuração POR ORGANIZAÇÃO, lida de `organizations.settings.agenda_externa`.
 *
 * ⚠️ ISTO NUNCA VAI PARA VARIÁVEL DE AMBIENTE, e a razão é concreta. Variável
 * de ambiente é da INSTALAÇÃO: numa instalação com quatro clientes, uma
 * credencial em `.env` fica ao alcance do agente de todos eles, e o que
 * separaria o studio dos dados do consultório passaria a ser alguém ter
 * lembrado de filtrar por organização no handler. Já aconteceu neste
 * repositório em outro conector, e ali faz sentido porque o que mora no `.env`
 * é o registro do aplicativo, não o acesso ao dado do cliente. Aqui é o acesso.
 *
 * O segredo em si não fica neste objeto: fica em `tenant_integrations`, que já
 * criptografa. Aqui fica só o que é configuração legível.
 */
export interface ConfigDeAgendaExterna {
  provedor: ProvedorDeAgendaExterna;
  /** Endereço base do sistema do cliente. */
  baseUrl: string;
  /** Fuso da grade, IANA. Ex: `America/Sao_Paulo`. */
  fuso: string;
  /**
   * Mapa `chave do CRM` → `identificador da modalidade no sistema externo`.
   * Modalidade ausente daqui é modalidade que NÃO se consulta — e esse é o
   * mecanismo que mantém Kids e dança fora de uma busca de funcional.
   */
  modalidades: Readonly<Record<string, { rotulo: string; externo: string }>>;
}
