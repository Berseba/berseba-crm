/**
 * Vocabulário fechado de nicho — a fonte que a rota `/api/v1/settings/nicho`
 * valida e que `camadas-da-org.ts` reexporta (`NICHO_SAUDE`). Este teste prova
 * o contrato sem banco: os cinco valores nomeados no CLAUDE.md (produto) são
 * aceitos, `null` (nenhuma escolha) é aceito, e qualquer outra coisa — nicho
 * fora da lista, valor de outro tipo — é rejeitada pelo Zod antes de chegar
 * perto do jsonb.
 */
import { describe, expect, it } from "vitest";

import { NICHOS, NICHO_LABELS, NICHO_SAUDE, nichoSchema } from "@/lib/organizacoes/nicho";

describe("NICHOS — vocabulário fechado", () => {
  it("tem exatamente os cinco nichos que o CLAUDE.md do produto nomeia", () => {
    expect(NICHOS).toEqual(["saude", "ecommerce", "imobiliaria", "infoproduto", "servicos"]);
  });

  it("NICHO_SAUDE é o valor que arma os freios clínicos", () => {
    expect(NICHO_SAUDE).toBe("saude");
    expect(NICHOS).toContain(NICHO_SAUDE);
  });

  it("todo nicho tem rótulo pt-BR", () => {
    for (const nicho of NICHOS) {
      expect(NICHO_LABELS[nicho]).toEqual(expect.any(String));
      expect(NICHO_LABELS[nicho].length).toBeGreaterThan(0);
    }
  });
});

describe("nichoSchema — o que a rota aceita", () => {
  it.each(NICHOS)("aceita o valor fechado '%s'", (nicho) => {
    expect(nichoSchema.safeParse(nicho).success).toBe(true);
  });

  it("aceita null — organização não escolheu", () => {
    const parsed = nichoSchema.safeParse(null);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBeNull();
  });

  it.each(["SAUDE", "saúde", "clinica", "", "outro", 123, {}, undefined])(
    "recusa valor fora do vocabulário: %j",
    (valor) => {
      expect(nichoSchema.safeParse(valor).success).toBe(false);
    },
  );
});
