/**
 * O NICHO DA ORG — a regra pura que arma o handoff de urgência médica.
 *
 * `nichoEhSaude` é a única condição que o freio de urgência médica
 * (`checkG4Medical`) consulta para decidir se entra em ação, nos call sites de
 * `workers/ai-response-worker.ts` e `lib/agent-engine/agent/inbound-turn.ts`.
 * (O veto de afirmação clínica é a camada `afirmacao_clinica` do fornecedor,
 * ligada pela rota do nicho — issue #35.) `checkG4Medical` em si é
 * nicho-agnóstico de propósito (ver `lib/ai/handoff/medical-emergency.ts`) — quem
 * decide se ele PODE disparar handoff é sempre esta função, no chamador.
 *
 * Este teste prova, sem banco, a garantia central do contrato: nenhuma
 * organização que não declarou `settings->>'nicho' = 'saude'` — ausente,
 * `null`, string vazia, ou qualquer outro nicho — arma o freio. `lerNichoDaOrg`
 * (a parte que fala com o Postgres) já falha ABERTO
 * para `null` por desenho (ver seu próprio cabeçalho); o que falta provar é
 * que `null` — e todo valor que não é exatamente `"saude"` — nunca vira
 * `true` aqui.
 */
import { describe, expect, it } from "vitest";

import { NICHO_SAUDE, nichoEhSaude } from "@/lib/agent-engine/guardrails/camadas-da-org";

describe("nichoEhSaude — a condição que arma o freio de urgência médica", () => {
  it("liga só para o nicho exato 'saude'", () => {
    expect(nichoEhSaude(NICHO_SAUDE)).toBe(true);
    expect(nichoEhSaude("saude")).toBe(true);
  });

  it("org sem nicho declarado (null) — o freio fica desligado", () => {
    expect(nichoEhSaude(null)).toBe(false);
  });

  it("qualquer outro nicho — o freio fica desligado", () => {
    for (const outro of ["imobiliaria", "ecommerce", "infoproduto", "servicos", "", "SAUDE", "Saúde"]) {
      expect(nichoEhSaude(outro), `nicho "${outro}" não deveria armar o freio`).toBe(false);
    }
  });
});
