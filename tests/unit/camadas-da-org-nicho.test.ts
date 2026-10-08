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
 * (a parte que fala com o Postgres) PROPAGA o erro de leitura desde a issue
 * #36 — erro não é "sem nicho" (ver o cabeçalho dela e o bloco abaixo); o que
 * falta provar aqui é que `null` — e todo valor que não é exatamente
 * `"saude"` — nunca vira `true`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { lerNichoDaOrg, NICHO_SAUDE, nichoEhSaude } from "@/lib/agent-engine/guardrails/camadas-da-org";

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

describe("lerNichoDaOrg — a read error is never 'no niche' (issue #36)", () => {
  const db = (query: () => Promise<unknown>) => ({ query }) as unknown as Parameters<typeof lerNichoDaOrg>[0];

  it("returns the niche, or null when the organization has none", async () => {
    await expect(lerNichoDaOrg(db(async () => ({ rows: [{ nicho: "saude" }] })), "org")).resolves.toBe("saude");
    await expect(lerNichoDaOrg(db(async () => ({ rows: [] })), "org")).resolves.toBeNull();
  });

  it("propagates a database error instead of disarming the brake", async () => {
    await expect(
      lerNichoDaOrg(
        db(async () => {
          throw new Error("connection terminated");
        }),
        "org",
      ),
    ).rejects.toThrow("connection terminated");
  });
});

describe("assisted-mode medical alert — a failed insert fails the job (issue #36)", () => {
  it("the alert insert is not followed by a swallowing .catch", () => {
    const src = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");
    const start = src.indexOf("title: 'Possível urgência médica relatada pelo contato'");
    const end = src.indexOf("rascunho aberto sem envio", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).not.toContain(".catch(");
  });
});
