/**
 * Berseba: the Jo OS evaluation slots tool (Instituto Jordão) as the screen shows it.
 *
 * It exists only for the organizations in `JOOS_AGENDA_ORG_IDS` (`lib/integrations/joos/config.ts`):
 * for every other one the served catalog, the agent turn and the external MCP drop it.
 * Bundle `atender` only, like avec and Mirae. Read only: there is no booking tool.
 */
import { declararTools } from "./tipos";

export const TOOLS_JOOS = declararTools([
  {
    name: "joos_evaluation_slots",
    category: "read",
    rotulo: "Ver horários livres de avaliação no Jo OS",
    explicacao:
      "Busca até 3 horários livres de avaliação na agenda do Instituto, na unidade que a pessoa escolheu, para o assistente sugerir. Não marca nada: quando a pessoa escolhe, o assistente passa para a equipe, que marca e confirma.",
    oQueToca: "Agenda de avaliações (Jo OS)",
    risco: "seguro",
    pacotes: ["atender"],
  },
]);
