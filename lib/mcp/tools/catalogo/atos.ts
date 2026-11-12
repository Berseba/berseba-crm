/**
 * Berseba: the Atos agenda tools (RBCOR) as the screen shows them.
 *
 * They exist only for the organizations in `ATOS_API_ORG_IDS` (`lib/integrations/atos/config.ts`):
 * for every other one the served catalog, the agent turn and the external MCP drop them.
 * Bundle `atender` only, like avec and Mirae. The writes are `critico`, so turning a bundle on
 * never adds them: someone has to tick each one.
 */
import { declararTools } from "./tipos";

const AGENDA = "Agenda do estúdio (Atos)";

export const TOOLS_ATOS = declararTools([
  {
    name: "atos_free_slots",
    category: "read",
    rotulo: "Ver horários com vaga no Atos",
    explicacao:
      "Mostra até 12 horários de aula com vaga na agenda do estúdio, já com as regras do estúdio e do plano da aluna.",
    oQueToca: AGENDA,
    risco: "seguro",
    pacotes: ["atender"],
  },
  {
    name: "atos_my_classes",
    category: "read",
    rotulo: "Ver as próximas aulas da aluna no Atos",
    explicacao:
      "Mostra as próximas aulas que a aluna desta conversa tem marcadas na agenda do estúdio, pelo telefone dela.",
    oQueToca: AGENDA,
    risco: "seguro",
    pacotes: ["atender"],
  },
  {
    name: "atos_cancel_class",
    category: "write",
    rotulo: "Desmarcar aula ou avisar falta no Atos",
    explicacao:
      "Desmarca uma aula da aluna desta conversa (também para falta avisada), depois de ela confirmar dia e horário, e diz se ela tem direito a reposição.",
    oQueToca: AGENDA,
    risco: "critico",
    pacotes: ["atender"],
  },
  {
    name: "atos_reschedule_class",
    category: "write",
    rotulo: "Remarcar aula no Atos",
    explicacao:
      "Troca o horário de uma aula da aluna desta conversa por outro com vaga, depois de ela confirmar o novo dia e horário.",
    oQueToca: AGENDA,
    risco: "critico",
    pacotes: ["atender"],
  },
  {
    name: "atos_book_makeup",
    category: "write",
    rotulo: "Marcar reposição no Atos",
    explicacao:
      "Marca a reposição de uma aula desmarcada da aluna desta conversa, dentro das regras de reposição do estúdio.",
    oQueToca: AGENDA,
    risco: "critico",
    pacotes: ["atender"],
  },
  {
    name: "atos_book_class",
    category: "write",
    rotulo: "Marcar aula no Atos",
    explicacao:
      "Marca uma aula para quem já é aluna, como a aula da semana de quem vem pelo TotalPass ou Wellhub, depois de ela confirmar dia e horário.",
    oQueToca: AGENDA,
    risco: "critico",
    pacotes: ["atender"],
  },
  {
    name: "atos_book_trial",
    category: "write",
    rotulo: "Marcar a primeira vivência no Atos",
    explicacao:
      "Cadastra a pessoa no Atos com nome, data de nascimento e plano, e marca a primeira aula. Com TotalPass ou Wellhub, a ponte reserva o plano antes.",
    oQueToca: AGENDA,
    risco: "critico",
    pacotes: ["atender"],
  },
]);
