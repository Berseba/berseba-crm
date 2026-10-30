/**
 * Berseba: the Mirae agenda tools (Fiore Pilates) as the screen shows them.
 *
 * They exist only for the organizations in `MIRAE_API_ORG_IDS` (`lib/integrations/mirae/config.ts`):
 * for every other one the served catalog, the agent turn and the external MCP drop them.
 * Bundle `atender` only, like avec. The writes are `critico`, so turning a bundle on never adds
 * them: someone has to tick each one.
 */
import { declararTools } from "./tipos";

export const TOOLS_MIRAE = declararTools([
  {
    name: "mirae_my_appointments",
    category: "read",
    rotulo: "Ver os agendamentos da pessoa no Mirae",
    explicacao:
      "Mostra a avaliação e as aulas que a pessoa desta conversa já tem marcadas na agenda do estúdio, pelo telefone dela, e se ela é interessada, aluna ou ex-aluna.",
    oQueToca: "Agenda do estúdio (Mirae)",
    risco: "seguro",
    pacotes: ["atender"],
  },
  {
    name: "mirae_services",
    category: "read",
    rotulo: "Ver os serviços e os planos do Mirae",
    explicacao:
      "Mostra o que o assistente marca sozinho (avaliação inicial e aula), os planos com valores que o estúdio liberou para as integrações e os prazos do estúdio.",
    oQueToca: "Agenda do estúdio (Mirae)",
    risco: "seguro",
    pacotes: ["atender"],
  },
  {
    name: "mirae_free_slots",
    category: "read",
    rotulo: "Ver horários livres no Mirae",
    explicacao:
      "Busca até 2 horários reais na agenda do estúdio, escolhidos pela regra do próprio estúdio, com dia, hora e profissional.",
    oQueToca: "Agenda do estúdio (Mirae)",
    risco: "seguro",
    pacotes: ["atender"],
  },
  {
    name: "mirae_book",
    category: "write",
    rotulo: "Marcar avaliação ou aula no Mirae",
    explicacao:
      "Marca a avaliação inicial ou a aula na agenda do estúdio para a pessoa desta conversa, depois de ela confirmar dia e hora. A avaliação marcada leva o card para a etapa de avaliação agendada.",
    oQueToca: "Agenda do estúdio (Mirae)",
    risco: "critico",
    pacotes: ["atender"],
  },
  {
    name: "mirae_reschedule",
    category: "write",
    rotulo: "Remarcar no Mirae",
    explicacao:
      "Muda o dia ou a hora da avaliação ou da aula da pessoa desta conversa na agenda do estúdio, dentro do prazo que o estúdio permite.",
    oQueToca: "Agenda do estúdio (Mirae)",
    risco: "critico",
    pacotes: ["atender"],
  },
  {
    name: "mirae_cancel",
    category: "write",
    rotulo: "Cancelar no Mirae",
    explicacao:
      "Cancela a avaliação ou a aula da pessoa desta conversa na agenda do estúdio, depois de oferecer remarcar e de ela confirmar.",
    oQueToca: "Agenda do estúdio (Mirae)",
    risco: "critico",
    pacotes: ["atender"],
  },
]);
