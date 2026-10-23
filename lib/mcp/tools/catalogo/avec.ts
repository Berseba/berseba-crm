/**
 * Berseba: the avec agenda tools (salon Mayara Morales) as the screen shows them.
 *
 * They exist only for the organizations in `AVEC_API_ORG_IDS` (`lib/integrations/avec/config.ts`):
 * for every other one the served catalog, the agent turn and the external MCP drop them.
 * Bundle `atender` only: `vender` already sits near `TETO_TOOLS_POR_AGENTE`. The writes are
 * `critico`, so turning a bundle on never adds them: someone has to tick each one.
 */
import { declararTools } from "./tipos";

export const TOOLS_AVEC = declararTools([
  {
    name: "avec_my_appointments",
    category: "read",
    rotulo: "Ver os agendamentos da cliente no avec",
    explicacao:
      "Mostra os horários que a cliente desta conversa já tem marcados na agenda do salão, pelo telefone dela, para o assistente confirmar dia e hora sem inventar.",
    oQueToca: "Agenda do salão (avec)",
    risco: "seguro",
    pacotes: ["atender"],
  },
  {
    name: "avec_find_services",
    category: "read",
    rotulo: "Ver os serviços que a atendente marca sozinha",
    explicacao:
      "Mostra a lista de serviços que o salão liberou para o assistente marcar sozinho, quem faz cada um e o que perguntar antes; o resto fica com a equipe.",
    oQueToca: "Agenda do salão (avec)",
    risco: "seguro",
    pacotes: ["atender"],
  },
  {
    name: "avec_free_slots",
    category: "read",
    rotulo: "Ver horários livres no avec",
    explicacao:
      "Busca de 2 a 3 horários reais na agenda do salão, com dia, hora e profissional, preferindo os colados em clientes que a profissional já tem no dia.",
    oQueToca: "Agenda do salão (avec)",
    risco: "seguro",
    pacotes: ["atender"],
  },
  {
    name: "avec_book",
    category: "write",
    rotulo: "Marcar horário no avec",
    explicacao:
      "Marca um horário novo na agenda do salão para a cliente desta conversa, depois de ela confirmar serviço, profissional, dia e hora.",
    oQueToca: "Agenda do salão (avec)",
    risco: "critico",
    pacotes: ["atender"],
  },
  {
    name: "avec_reschedule",
    category: "write",
    rotulo: "Remarcar horário no avec",
    explicacao:
      "Muda o dia ou a hora de um agendamento da cliente desta conversa na agenda do salão, com a mesma profissional e o mesmo serviço.",
    oQueToca: "Agenda do salão (avec)",
    risco: "critico",
    pacotes: ["atender"],
  },
  {
    name: "avec_cancel",
    category: "write",
    rotulo: "Cancelar horário no avec",
    explicacao:
      "Cancela um agendamento da cliente desta conversa na agenda do salão, depois de oferecer remarcar e de ela confirmar o cancelamento.",
    oQueToca: "Agenda do salão (avec)",
    risco: "critico",
    pacotes: ["atender"],
  },
]);
