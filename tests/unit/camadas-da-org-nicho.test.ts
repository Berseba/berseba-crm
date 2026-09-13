/**
 * O NICHO DA ORG — a regra pura que arma os dois freios clínicos.
 *
 * `nichoEhSaude` é a única condição que os dois freios clínicos consultam
 * para decidir se entram em ação: o Freio 1 (`checkG4Medical`, urgência
 * médica) nos call sites de `workers/ai-response-worker.ts` e
 * `lib/agent-engine/agent/inbound-turn.ts`, e o Freio 2 (`clinicalScopeGate`,
 * `before-send.ts`) via `GateContext.nichoSaude`. `checkG4Medical` em si é
 * nicho-agnóstico de propósito (ver `lib/ai/handoff/triggers.ts`) — quem
 * decide se ele PODE disparar handoff é sempre esta função, no chamador.
 *
 * Este teste prova, sem banco, a garantia central do contrato: nenhuma
 * organização que não declarou `settings->>'nicho' = 'saude'` — ausente,
 * `null`, string vazia, ou qualquer outro nicho — arma qualquer um dos dois
 * freios. `lerNichoDaOrg` (a parte que fala com o Postgres) já falha ABERTO
 * para `null` por desenho (ver seu próprio cabeçalho); o que falta provar é
 * que `null` — e todo valor que não é exatamente `"saude"` — nunca vira
 * `true` aqui.
 */
import { describe, expect, it } from "vitest";

import { NICHO_SAUDE, nichoEhSaude } from "@/lib/agent-engine/guardrails/camadas-da-org";

describe("nichoEhSaude — a condição que arma os dois freios clínicos", () => {
  it("liga só para o nicho exato 'saude'", () => {
    expect(nichoEhSaude(NICHO_SAUDE)).toBe(true);
    expect(nichoEhSaude("saude")).toBe(true);
  });

  it("org sem nicho declarado (null) — os dois freios ficam desligados", () => {
    expect(nichoEhSaude(null)).toBe(false);
  });

  it("qualquer outro nicho — os dois freios ficam desligados", () => {
    for (const outro of ["imobiliaria", "ecommerce", "infoproduto", "servicos", "", "SAUDE", "Saúde"]) {
      expect(nichoEhSaude(outro), `nicho "${outro}" não deveria armar o freio`).toBe(false);
    }
  });
});
