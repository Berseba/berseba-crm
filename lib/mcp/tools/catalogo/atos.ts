/**
 * Berseba: the Atos agenda tools (RBCOR) as the screen shows them.
 *
 * They exist only for the organizations in `ATOS_API_ORG_IDS` (`lib/integrations/atos/config.ts`):
 * for every other one the served catalog, the agent turn and the external MCP drop them.
 * Bundle `atender` only, like avec and Mirae. Read only in this phase.
 */
import { declararTools } from "./tipos";

export const TOOLS_ATOS = declararTools([
  {
    name: "atos_free_slots",
    category: "read",
    rotulo: "Ver horários com vaga no Atos",
    explicacao:
      "Mostra até 12 horários de aula com vaga na agenda do estúdio, já com as regras do estúdio e do plano da aluna. A vaga é informação: quem marca é a recepção.",
    oQueToca: "Agenda do estúdio (Atos)",
    risco: "seguro",
    pacotes: ["atender"],
  },
  {
    name: "atos_my_classes",
    category: "read",
    rotulo: "Ver as próximas aulas da aluna no Atos",
    explicacao:
      "Mostra as próximas aulas que a aluna desta conversa tem marcadas na agenda do estúdio, pelo telefone dela.",
    oQueToca: "Agenda do estúdio (Atos)",
    risco: "seguro",
    pacotes: ["atender"],
  },
]);
