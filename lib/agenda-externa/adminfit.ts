/**
 * Adaptador ADMIN FIT — a grade de turmas do Studio Bruno Alves.
 *
 * O QUE FOI MEDIDO NO SISTEMA, com acesso do dono (setembro/2026)
 * --------------------------------------------------------------------------
 * - É uma aplicação de página única sobre Firebase/Firestore. Não tem API REST
 *   pública, não tem documentação de integração, e o fornecedor não publica
 *   contrato.
 * - A tela que interessa é "Turma do dia" (`/adm/#/calendario`). Ela mostra,
 *   por dia e por horário, a turma e quantas vagas sobraram — inclusive o
 *   estado "sem disponibilidade".
 * - A mesma tela mistura Novum Funcional, Treinos Personalizados, Kids e as
 *   turmas de dança. É por isso que `modalidades` abaixo é uma allowlist e não
 *   um filtro opcional: o que não está mapeado não é consultável, e turma
 *   infantil não vaza para uma busca de adulto.
 * - A autenticação é Firebase Auth, com token de vida curta (cerca de 1 hora).
 *   Isso descarta guardar "uma chave" e esquecer: qualquer transporte precisa
 *   renovar sessão.
 * - A grade da semana seguinte só é publicada às quintas. Uma consulta com
 *   horizonte longo devolve menos dias do que o pedido, e isso é a grade
 *   estando certa — não é falha.
 *
 * ⚠️ O TRANSPORTE NÃO ESTÁ DECIDIDO, E ESTE ARQUIVO NÃO O CHUTA.
 * --------------------------------------------------------------------------
 * Há três caminhos possíveis para efetivamente ler a grade, e a escolha é
 * comercial e jurídica antes de ser técnica:
 *
 *   (a) pedir uma interface ao fornecedor do Admin Fit — o único caminho com
 *       contrato; depende de eles quererem;
 *   (b) sessão de navegador guardada, renovada por rotina nossa — funciona sem
 *       pedir licença a ninguém, e quebra quando eles mexerem na tela;
 *   (c) falar direto com o Firestore do projeto deles — foi avaliado e
 *       RECUSADO: é o banco de um terceiro, com dado de saúde de aluno dentro,
 *       e um acesso desses não se justifica por conveniência nossa.
 *
 * Enquanto (a) ou (b) não estiver de pé, `criarAdaptadorAdminFit` devolve um
 * adaptador que responde `indisponivel` — de propósito. Um adaptador que
 * inventasse horário para "ficar verde" produziria a falha cara: o agente
 * oferece quinta às 7h, a pessoa aparece, e a turma está cheia.
 */
import type {
  AdaptadorDeAgendaExterna,
  ConfigDeAgendaExterna,
  ConsultaDeVagas,
  ModalidadeExterna,
  PerguntaDeVagas,
  VagaExterna,
} from "./tipos";

/**
 * Como a grade do Admin Fit chega depois de lida — seja por interface do
 * fornecedor, seja por sessão de navegador. Os dois transportes produzem esta
 * forma, e é por isso que ela existe: trocar (b) por (a) não deve mexer em
 * nada abaixo desta linha.
 */
export interface LinhaDaGradeAdminFit {
  dia: string;
  hora: string;
  /** Identificador da modalidade COMO O ADMIN FIT chama. */
  modalidadeExterna: string;
  vagasLivres: number | null;
  capacidade: number | null;
  turma: string | null;
}

/**
 * A função que efetivamente busca a grade. Injetada, nunca importada — é o que
 * mantém este arquivo testável sem rede e o que permite trocar o transporte
 * sem reescrever a tradução.
 */
export type TransporteAdminFit = (
  config: ConfigDeAgendaExterna,
  pergunta: PerguntaDeVagas,
) => Promise<ReadonlyArray<LinhaDaGradeAdminFit>>;

/**
 * Transporte padrão: recusa.
 *
 * Não é placeholder esquecido — é a postura correta enquanto a decisão de
 * acesso não existe. Ver o aviso no topo.
 */
const TRANSPORTE_NAO_CONFIGURADO: TransporteAdminFit = async () => {
  throw new Error(
    "transporte do Admin Fit não configurado — decidir entre interface do " +
      "fornecedor ou sessão de navegador antes de ligar a consulta",
  );
};

/** Vagas em `0` e vagas desconhecidas são coisas diferentes. Ver `tipos.ts`. */
function normalizarVagas(valor: number | null | undefined): number | null {
  if (valor === null || valor === undefined) return null;
  if (!Number.isFinite(valor)) return null;
  return Math.max(0, Math.trunc(valor));
}

export function criarAdaptadorAdminFit(
  config: ConfigDeAgendaExterna,
  transporte: TransporteAdminFit = TRANSPORTE_NAO_CONFIGURADO,
): AdaptadorDeAgendaExterna {
  // `chave do CRM` → modalidade, e o inverso, para traduzir a resposta de volta.
  const porChave = new Map<string, { rotulo: string; externo: string }>(
    Object.entries(config.modalidades),
  );
  const porExterno = new Map<string, ModalidadeExterna>();
  for (const [chave, m] of porChave) {
    porExterno.set(m.externo, { chave, rotulo: m.rotulo });
  }

  const modalidades: ReadonlyArray<ModalidadeExterna> = [...porChave].map(
    ([chave, m]) => ({ chave, rotulo: m.rotulo }),
  );

  return {
    provedor: "adminfit",
    modalidades,

    async consultar(pergunta: PerguntaDeVagas): Promise<ConsultaDeVagas> {
      const alvo = porChave.get(pergunta.modalidade);
      if (!alvo) {
        // Modalidade fora da allowlist NÃO é erro de digitação a ser tolerado:
        // é a trava que impede uma busca de funcional devolver turma infantil.
        return {
          situacao: "indisponivel",
          motivo:
            `modalidade "${pergunta.modalidade}" não está mapeada para esta ` +
            `organização — mapeadas: ${modalidades.map((m) => m.chave).join(", ") || "nenhuma"}`,
        };
      }

      let linhas: ReadonlyArray<LinhaDaGradeAdminFit>;
      try {
        linhas = await transporte(config, pergunta);
      } catch (e) {
        // Falha vira estado, não exceção — o agente precisa poder dizer
        // "vou confirmar e te aviso" em vez de inventar horário.
        return {
          situacao: "indisponivel",
          motivo: e instanceof Error ? e.message : "falha ao ler a grade",
        };
      }

      const vagas: VagaExterna[] = [];
      for (const linha of linhas) {
        // Cinto e suspensório: mesmo que o transporte traga a grade inteira
        // (é uma tela só, ele pode), aqui só passa a modalidade pedida.
        if (linha.modalidadeExterna !== alvo.externo) continue;
        const modalidade = porExterno.get(linha.modalidadeExterna);
        if (!modalidade) continue;
        vagas.push({
          dia: linha.dia,
          hora: linha.hora,
          modalidade,
          vagasLivres: normalizarVagas(linha.vagasLivres),
          capacidade: normalizarVagas(linha.capacidade),
          turma: linha.turma ?? null,
        });
      }

      vagas.sort((a, b) => (a.dia + a.hora).localeCompare(b.dia + b.hora));
      return { situacao: "ok", vagas, consultadoEm: new Date().toISOString() };
    },
  };
}
