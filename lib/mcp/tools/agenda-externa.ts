/**
 * A ferramenta de GRADE EXTERNA — vagas que vivem no sistema do cliente.
 *
 * ⚠️ FACHADA FINA. Nenhuma regra nasce aqui: a resolução por organização, a
 * leitura da configuração e a tradução de modalidade são de `lib/agenda-externa`.
 * Este arquivo só traduz entrada/saída para o vocabulário do modelo.
 *
 * ⚠️ IRMÃ, NÃO SUBSTITUTA de `crm_find_free_slots`. As duas dizem "horário
 * livre" e a diferença importa:
 *
 *   `crm_find_free_slots`      → a agenda DESTE CRM. Quem marca somos nós, e o
 *                                horário fica reservado de verdade.
 *   `crm_find_external_slots`  → a grade de turmas que o cliente mantém no
 *                                sistema dele. Nós só LEMOS. Marcar continua
 *                                sendo ato de gente, do lado de lá.
 *
 * A `description` abre por esse discriminante, antes de dizer o que a tool faz,
 * porque é o que separa as duas na hora da escolha.
 *
 * ⚠️ `ctx.supabase` É SERVICE ROLE e passa por cima da RLS. `consultarVagasDaOrg`
 * recebe `ctx.organizationId` e filtra por ele — é o que separa esta chamada de
 * uma organização lendo a grade da outra.
 */
import { z } from "zod";

import {
  consultarVagasDaOrg,
  DIAS_MAX,
  DIAS_PADRAO,
} from "@/lib/agenda-externa";
import type { McpToolDefinition } from "@/lib/mcp/types";

/**
 * Teto de itens devolvidos.
 *
 * A grade de uma semana de studio já passa de 60 horários, e lista longa entra
 * inteira no contexto do turno: é cara e piora a escolha do modelo. Duas
 * semanas de turmas cabem confortavelmente em 40.
 */
const VAGAS_MAX = 40;

const gradeExternaShape = {
  modalidade: z
    .string()
    .min(1)
    .describe(
      "Obrigatório. A modalidade que a pessoa quer — a mesma do funil em que ela está. " +
        "A ocupação da sala muda conforme a atividade, então vaga sem modalidade não " +
        "quer dizer nada. Se você não sabe qual é, pergunte à pessoa antes de chamar.",
    ),
  dias_a_frente: z
    .number()
    .int()
    .min(1)
    .max(DIAS_MAX)
    .optional()
    .describe(
      `Quantos dias olhar a partir de hoje. Padrão ${DIAS_PADRAO}, máximo ${DIAS_MAX}.`,
    ),
} satisfies z.ZodRawShape;

export const crmFindExternalSlots: McpToolDefinition<typeof gradeExternaShape> = {
  name: "crm_find_external_slots",
  description:
    "Lê a grade de turmas que o cliente mantém no sistema DELE — é só consulta, não reserva nada. " +
    "Para a agenda deste CRM, onde marcar realmente segura o horário, use `crm_find_free_slots`. " +
    "Use ANTES de oferecer um horário de turma: oferecer vaga que não existe e depois voltar atrás " +
    "é pior do que demorar um instante a mais. " +
    "`modalidade` é OBRIGATÓRIA e deve ser a mesma do funil da pessoa — a mesma sala comporta " +
    "gente diferente conforme a atividade, e turma infantil ou de dança nunca deve aparecer em " +
    "busca de turma de adulto. " +
    "Leia `situacao` antes de qualquer coisa: " +
    "`ok` = a grade respondeu, ofereça o que veio; " +
    "`indisponivel` = NÃO conseguimos ler a grade agora — não invente horário e não diga que está " +
    "lotado; diga que alguém da equipe confirma e volta; " +
    "`nao_configurado` = este cliente não tem grade externa, use `crm_find_free_slots`. " +
    "Em cada horário, `vagas_livres` igual a 0 é turma cheia; `vagas_livres` nulo significa que o " +
    "sistema não informou — nesse caso ofereça pedindo confirmação, sem afirmar que tem vaga. " +
    "Lista vazia com `situacao` ok significa que não há turma dessa modalidade no período — não é " +
    "erro, e também não é 'tudo lotado'. " +
    "A grade costuma publicar a semana seguinte só às quintas, então pedir muitos dias não traz " +
    "mais resultado do que pedir duas semanas.",
  inputSchema: gradeExternaShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    // O intervalo NÃO é montado aqui de propósito: o primeiro dia da grade
    // depende do fuso da agenda do cliente, e quem conhece esse fuso é a camada
    // que lê a configuração dele. Ver o aviso em `lib/agenda-externa/index.ts`.
    const resultado = await consultarVagasDaOrg(ctx.supabase, ctx.organizationId, {
      modalidade: input.modalidade,
      diasAFrente: input.dias_a_frente ?? DIAS_PADRAO,
    });

    if (resultado.situacao === "nao_configurado") {
      return {
        situacao: "nao_configurado",
        mensagem:
          "esta organização não tem grade externa configurada — os horários de casa " +
          "estão em crm_find_free_slots.",
        horarios: [],
      };
    }

    if (resultado.situacao === "indisponivel") {
      return {
        situacao: "indisponivel",
        motivo: resultado.motivo,
        mensagem:
          "não deu para ler a grade agora. Não ofereça horário nem diga que está lotado: " +
          "avise que alguém da equipe confirma e retorna.",
        horarios: [],
      };
    }

    const todos = resultado.vagas;
    const horarios = todos.slice(0, VAGAS_MAX).map((v) => ({
      quando: `${v.dia} ${v.hora}`,
      dia: v.dia,
      hora: v.hora,
      modalidade: v.modalidade.rotulo,
      vagas_livres: v.vagasLivres,
      capacidade: v.capacidade,
      turma: v.turma,
    }));

    return {
      situacao: "ok",
      consultado_em: resultado.consultadoEm,
      total_de_horarios: todos.length,
      ha_mais: todos.length > horarios.length,
      horarios,
    };
  },
};
