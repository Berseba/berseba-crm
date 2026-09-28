/**
 * Capacidade de GRADE EXTERNA — ler as turmas que o cliente mantém no sistema dele.
 *
 * ESTE ARQUIVO FALA COM O HUMANO que configura o agente. O texto que vai ao
 * MODELO é a `description` do handler (`lib/mcp/tools/agenda-externa.ts`), e ela
 * não tem cópia aqui — duplicata que ninguém lê não é documentação, é armadilha.
 *
 * ⚠️ O VOCABULÁRIO DE QUEM CONFIGURA NÃO É O NOSSO. Quem lê esta tela é dono de
 * studio, de clínica, de escola: ele diz TURMA, HORÁRIO e VAGA. As palavras de
 * dentro ficam só no `name`, que é contrato e não texto de tela.
 *
 * ⚠️ POR QUE A CAPACIDADE É GENÉRICA E NÃO "ADMIN FIT". O primeiro cliente a
 * usar isto tem a grade num sistema chamado Admin Fit, e a tentação era nomear
 * a capacidade assim. Numa instalação que atende várias empresas, um nome de
 * fornecedor no catálogo apareceria na tela de TODAS elas — inclusive das que
 * nunca ouviram falar desse sistema. O nome do fornecedor de cada uma vive na
 * configuração dela, não aqui.
 */
import { declararTools } from "./tipos";

export const TOOLS_AGENDA_EXTERNA = declararTools([
  {
    name: "crm_find_external_slots",
    category: "read",
    rotulo: "Ver vagas nas turmas do seu outro sistema",
    explicacao:
      "A IA abre a grade de turmas que você já mantém no seu outro sistema e vê " +
      "quais horários ainda têm vaga, antes de oferecer qualquer um deles para a " +
      "pessoa. Ela só olha: não marca nada lá, não altera nada lá, e não apaga " +
      "nada lá. Quem confirma a turma continua sendo alguém da sua equipe. Se a " +
      "grade não responder na hora, a IA avisa que a equipe confirma depois — ela " +
      "nunca inventa um horário nem diz que está lotado por conta própria.",
    oQueToca: "Grade de turmas do seu outro sistema",
    risco: "seguro",
    pacotes: ["atender", "vender"],
  },
]);
