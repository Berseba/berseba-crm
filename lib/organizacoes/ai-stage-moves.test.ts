import { describe, expect, it, vi } from "vitest";

import {
  AI_STAGE_MOVES_DEFAULT,
  AI_STAGE_MOVES_FAIL_CLOSED,
  AI_STAGE_MOVES_MODES,
  aiStageMovesModeSchema,
  lerAiStageMoves,
  lerAiStageMovesFailClosed,
} from "./ai-stage-moves";

const ORG = "11111111-1111-4111-8111-111111111111";

/** Evita repetir `vi.fn().mockResolvedValue`/`mockRejectedValue` nos casos do pg.Pool. */
function viQuery(row: Record<string, unknown>) {
  return vi.fn().mockResolvedValue({ rows: [row] });
}
function viReject(err: Error) {
  return vi.fn().mockRejectedValue(err);
}

describe("vocabulário", () => {
  it("dois valores fechados, e o default é 'auto' (compatível com toda instalação existente)", () => {
    expect(AI_STAGE_MOVES_MODES).toEqual(["auto", "suggest"]);
    expect(AI_STAGE_MOVES_DEFAULT).toBe("auto");
  });

  it("fail-closed é 'suggest', nunca 'auto' — cinto que falha calado não é cinto", () => {
    expect(AI_STAGE_MOVES_FAIL_CLOSED).toBe("suggest");
  });

  it.each(AI_STAGE_MOVES_MODES)("schema aceita o valor fechado '%s'", (modo) => {
    expect(aiStageMovesModeSchema.safeParse(modo).success).toBe(true);
  });

  it.each(["AUTO", "manual", "", null, undefined, 123])(
    "schema recusa valor fora do vocabulário: %j",
    (valor) => {
      expect(aiStageMovesModeSchema.safeParse(valor).success).toBe(false);
    },
  );
});

describe("lerAiStageMoves — via pg.Pool", () => {
  it("lê o modo gravado", async () => {
    const query = viQuery({ modo: "suggest" });
    const pool = { query } as never;

    const r = await lerAiStageMoves(pool, ORG);

    expect(r).toBe("suggest");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("ai_stage_moves"), [ORG]);
  });

  it("ausência de configuração (org nova) é 'auto', não erro", async () => {
    const query = viQuery({ modo: null });
    const pool = { query } as never;

    expect(await lerAiStageMoves(pool, ORG)).toBe("auto");
  });

  it("valor gravado fora do vocabulário (lixo/legado) degrada para 'auto', não lança", async () => {
    const query = viQuery({ modo: "yolo" });
    const pool = { query } as never;

    expect(await lerAiStageMoves(pool, ORG)).toBe("auto");
  });

  it("erro na query: propaga (quem decide o fail-closed é o chamador)", async () => {
    const query = viReject(new Error("connection reset"));
    const pool = { query } as never;

    await expect(lerAiStageMoves(pool, ORG)).rejects.toThrow("connection reset");
  });
});

describe("lerAiStageMoves — via SupabaseClient", () => {
  function adminStub(resposta: { data: unknown; error: { message: string } | null }) {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => Promise.resolve(resposta),
    };
    return { from: () => chain } as never;
  }

  it("lê settings.crm.ai_stage_moves", async () => {
    const admin = adminStub({ data: { settings: { crm: { ai_stage_moves: "suggest" } } }, error: null });

    expect(await lerAiStageMoves(admin, ORG)).toBe("suggest");
  });

  it("organização sem settings.crm (clone que nunca abriu a tela): 'auto'", async () => {
    const admin = adminStub({ data: { settings: {} }, error: null });

    expect(await lerAiStageMoves(admin, ORG)).toBe("auto");
  });

  it("organização sem linha (data null): 'auto'", async () => {
    const admin = adminStub({ data: null, error: null });

    expect(await lerAiStageMoves(admin, ORG)).toBe("auto");
  });

  it("erro na leitura: lança (fail-closed é do CHAMADOR, não desta função)", async () => {
    const admin = adminStub({ data: null, error: { message: "boom" } });

    await expect(lerAiStageMoves(admin, ORG)).rejects.toThrow(/boom/);
  });
});

describe("lerAiStageMovesFailClosed", () => {
  it("leitura ok: repassa o valor lido", async () => {
    const admin = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { settings: { crm: { ai_stage_moves: "auto" } } }, error: null }) }) }),
      }),
    } as never;

    expect(await lerAiStageMovesFailClosed(admin, ORG)).toBe("auto");
  });

  it("leitura falha: 'suggest', NUNCA 'auto' — mover sozinho é a escolha errada quando o knob é desconhecido", async () => {
    const admin = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "timeout" } }) }) }),
      }),
    } as never;

    expect(await lerAiStageMovesFailClosed(admin, ORG)).toBe("suggest");
  });
});
