/**
 * Berseba: `crm_list_lead_events` as the screen shows it (Berseba/berseba#270).
 *
 * Read by the platform's Prospector worker through the external MCP with a `dsk_` token.
 * It reads only events (when, what kind, which channel), never text or contact data.
 *
 * Bundle `escalar` ("what already happened" for the person who takes over), and on purpose
 * not `reter`/`vender`/`organizar`/`evoluir`: measured on 2026-11-19, `reter` alone would go
 * to 28 against the ceiling of 27 (tests/unit/selecao-por-pacote.test.ts), `organizar`
 * alone too (tests/unit/pacote-reserva-vaga-da-critica.test.ts), and `vender` or `evoluir`
 * would leave no journey that fits after onboarding
 * (tests/unit/capacidades-padrao-do-onboarding.test.ts).
 */
import { declararTools } from "./tipos";

export const TOOLS_LEAD_EVENTS = declararTools([
  {
    name: "crm_list_lead_events",
    category: "read",
    rotulo: "Ver os toques, respostas e reuniões dos negócios",
    explicacao:
      "Mostra quando cada oportunidade recebeu um toque da equipe, quando o cliente respondeu e quando uma reunião foi marcada, com o canal. Não traz o texto das mensagens nem dados do contato.",
    oQueToca: "Funil de vendas",
    risco: "seguro",
    pacotes: ["escalar"],
  },
]);
