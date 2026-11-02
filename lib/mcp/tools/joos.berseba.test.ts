/**
 * Berseba: the Jo OS evaluation slots tool (Instituto Jordão). `fetch` is mocked: no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const URL_JOOS = "https://jo.example.supabase.co/functions/v1/crm-agenda-avaliacao";
const U1 = "18f65d74-0000-4000-8000-000000000001";
const U2 = "18f65d74-0000-4000-8000-000000000002";

const { captureMessage } = vi.hoisted(() => ({ captureMessage: vi.fn() }));

vi.mock("@/lib/integrations/joos/config", () => {
  const config = { url: URL_JOOS, secret: "segredo-de-teste", orgIds: new Set([ORG]) };
  return {
    JOOS_TOOL_PREFIX: "joos_",
    joOsConfigFor: (org: string) => (org === ORG ? config : null),
    isJoOsToolHiddenFor: (name: string, org: string) => name.startsWith("joos_") && org !== ORG,
  };
});
vi.mock("@sentry/nextjs", () => ({ captureMessage }));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn().mockResolvedValue(undefined) }));

const tools = await import("./joos");
const { allTools } = await import("./index");
const { TOOL_CATALOG } = await import("./catalog");
const { pickToolsFromMcp } = await import("@/lib/ai/runtime/tools");

type Args = Record<string, unknown>;
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** A free slot as `crm-agenda-avaliacao` answers it. */
function slot(dia: string, hora: string, unidade = "Unidade 1", unidadeId = U1, avaliador: string | null = "Isabella") {
  return {
    unidade_id: unidadeId,
    unidade,
    dia,
    hora,
    inicio: `${dia}T${hora}:00-03:00`,
    fim: `${dia}T${String(Number(hora.slice(0, 2)) + 1).padStart(2, "0")}:${hora.slice(3)}:00-03:00`,
    avaliadores_livres: avaliador ? 1 : 0,
    avaliador_sugerido: avaliador,
  };
}
const ok = (horarios: unknown[]) => ({
  situacao: "ok",
  consultado_em: "2026-11-02T23:00:00Z",
  fuso: "America/Sao_Paulo",
  duracao_min: 60,
  horarios,
});

let calls: Call[] = [];
let answers: Array<{ status: number; body: unknown } | Error> = [];
const answer = (status: number, body: unknown) => answers.push({ status, body });

beforeEach(() => {
  calls = [];
  answers = [];
  captureMessage.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-02T23:00:00Z")); // segunda, 20h em Brasília
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      calls.push({
        url: String(input),
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const next = answers.shift();
      if (!next) throw new Error("no answer queued");
      if (next instanceof Error) throw next;
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ctx = (organizationId = ORG) =>
  ({
    organizationId,
    role: "ai_operator",
    actor: { type: "ai_agent", id: "ag-1", agent_id: "ag-1", role: "ai_operator" },
    apiTokenId: "tok-1",
    requestId: "req-1",
    supabase: {},
  }) as never;

const run = (args: Args, c = ctx()) =>
  tools.joosEvaluationSlots.handler(args as never, c) as Promise<Args>;

describe("gates", () => {
  it("refuses another organization without calling Jo OS", async () => {
    const r = await run({ unidade: "1" }, ctx(OTHER_ORG));
    expect(r).toMatchObject({ ok: false, motivo: "joos_indisponivel", handoff: false });
    expect(calls).toHaveLength(0);
  });

  it("the tool reads only: no Jo OS tool writes", () => {
    for (const t of allTools.filter((t) => t.name.startsWith("joos_"))) {
      expect(t.category, t.name).toBe("read");
      expect(t.requiresScope, t.name).toBe("mcp:read");
    }
  });
});

describe("client", () => {
  it("POSTs the read action with the secret in the header, never in the URL or body", async () => {
    answer(200, ok([slot("2026-11-03", "09:00")]));
    await run({ unidade: "1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL_JOOS);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["x-crm-agenda-secret"]).toBe("segredo-de-teste");
    expect(calls[0]!.body).toEqual({ acao: "horarios" });
    expect(JSON.stringify(calls[0]!.body)).not.toContain("segredo");
  });

  it("an exact day goes to Jo OS as de = ate", async () => {
    answer(200, ok([slot("2026-11-04", "10:00")]));
    await run({ unidade: "1", data: "2026-11-04" });
    expect(calls[0]!.body).toEqual({ acao: "horarios", de: "2026-11-04", ate: "2026-11-04" });
  });

  it("no answer hands off without alerting", async () => {
    const err = new Error("aborted");
    err.name = "TimeoutError";
    answers.push(err);
    const r = await run({ unidade: "1" });
    expect(r).toMatchObject({ ok: false, motivo: "joos_sem_resposta", handoff: true });
    expect(String(r.todo)).toContain("unidade 1");
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("a wrong secret hands off and alerts the CRM team", async () => {
    answer(401, { situacao: "nao_autorizado" });
    const r = await run({ unidade: "1" });
    expect(r).toMatchObject({ ok: false, motivo: "joos_sem_resposta", handoff: true });
    await vi.dynamicImportSettled();
    expect(captureMessage).toHaveBeenCalledWith(
      "[joos] falha na integração: nao_autorizado",
      expect.objectContaining({ tags: { subsystem: "joos", code: "nao_autorizado" } }),
    );
  });

  it("an unexpected 2xx body is invalid_response: hand off and alert", async () => {
    answer(200, { horarios: "nope" });
    const r = await run({ unidade: "1" });
    expect(r).toMatchObject({ ok: false, handoff: true });
    await vi.dynamicImportSettled();
    expect(captureMessage).toHaveBeenCalledWith("[joos] falha na integração: invalid_response", expect.anything());
  });

  it("the Jo OS switch off hands off, with what the person wants in the todo", async () => {
    answer(200, { situacao: "desligado" });
    const r = await run({ unidade: "2", periodo: "tarde" });
    expect(r).toMatchObject({ ok: false, motivo: "joos_desligado", handoff: true });
    expect(String(r.todo)).toContain("unidade 2 (tarde)");
  });
});

describe("joos_evaluation_slots", () => {
  const SEMANA = [
    slot("2026-11-03", "09:00"),
    slot("2026-11-03", "10:00"),
    slot("2026-11-03", "15:00"),
    slot("2026-11-04", "09:00", "Unidade 1", U1, "Leandro"),
    slot("2026-11-05", "19:00"),
    slot("2026-11-06", "08:00"),
    slot("2026-11-03", "08:00", "Unidade 2", U2),
  ];

  it("offers up to 3 options of the asked unit, one per day, with the text to repeat", async () => {
    answer(200, ok(SEMANA));
    const r = await run({ unidade: "Unidade 1" });
    expect(r).toMatchObject({ ok: true, so_sugestao: true });
    const opcoes = r.opcoes as Args[];
    expect(opcoes.map((o) => o.texto)).toEqual([
      "terça, 03/11, às 9h",
      "quarta, 04/11, às 9h",
      "quinta, 05/11, às 19h",
    ]);
    expect(opcoes.every((o) => o.unidade === "Unidade 1")).toBe(true);
    expect(opcoes[1]!.avaliador_livre).toBe("Leandro");
    expect(String(r.proximo_passo)).toContain("NÃO diga que está marcado");
  });

  it("with one day asked, the first options of that day", async () => {
    answer(200, ok(SEMANA.filter((s) => s.dia === "2026-11-03")));
    const r = await run({ unidade: "1", data: "2026-11-03" });
    expect((r.opcoes as Args[]).map((o) => o.hora)).toEqual(["09:00", "10:00", "15:00"]);
  });

  it("filters by period", async () => {
    answer(200, ok(SEMANA));
    const r = await run({ unidade: "1", periodo: "noite" });
    expect((r.opcoes as Args[]).map((o) => o.texto)).toEqual(["quinta, 05/11, às 19h"]);
  });

  it("a past date is refused without calling Jo OS", async () => {
    const r = await run({ unidade: "1", data: "2026-11-01" });
    expect(r).toMatchObject({ ok: false, handoff: false });
    expect(calls).toHaveLength(0);
  });

  it("an unknown unit asks the person, naming the units that have slots", async () => {
    answer(200, ok(SEMANA));
    const r = await run({ unidade: "7" });
    expect(r).toMatchObject({ ok: false, handoff: false });
    expect(String(r.mensagem)).toContain("Unidade 1, Unidade 2");
  });

  it("a known unit with nothing free hands off, never says there is no slot", async () => {
    answer(200, ok(SEMANA));
    const r = await run({ unidade: "2", periodo: "noite" });
    expect(r).toMatchObject({ ok: false, motivo: "sem_horario", handoff: true });
    expect(String(r.mensagem)).toContain("Não diga que não há horário");
  });

  it('"1" names Unidade 1 and not Unidade 12', () => {
    expect(tools.unitMatches("1", "Unidade 1")).toBe(true);
    expect(tools.unitMatches("unidade  1", "Unidade 1")).toBe(true);
    expect(tools.unitMatches("1", "Unidade 12")).toBe(false);
    expect(tools.unitMatches("", "Unidade 1")).toBe(false);
  });
});

describe("registration", () => {
  it("the tool is in the handler index and the catalog, read and seguro, bundle atender", () => {
    expect(allTools.filter((t) => t.name.startsWith("joos_")).map((t) => t.name)).toEqual(["joos_evaluation_slots"]);
    const entry = TOOL_CATALOG.find((t) => t.name === "joos_evaluation_slots");
    expect(entry?.category).toBe("read");
    expect(entry?.risco).toBe("seguro");
    expect(entry?.pacotes).toEqual(["atender"]);
    expect(entry?.oQueToca).toBe("Agenda de avaliações (Jo OS)");
  });

  it("the agent turn offers it only to the enabled organization", () => {
    const build = (org: string) => {
      const actor = { type: "ai_agent", id: "ag-1", role: "ai_operator" };
      return pickToolsFromMcp({
        toolIds: ["joos_evaluation_slots"],
        auth: { organizationId: org, role: "ai_operator", scopes: ["mcp:read", "mcp:write"], actor, apiTokenId: "t" },
        ctx: { organizationId: org, role: "ai_operator", actor, apiTokenId: "t", requestId: "r", supabase: {} },
        supabase: {},
        pipelineIds: [],
        handoffToolEnabled: false,
        handoffSignal: { triggered: false },
      } as never);
    };
    expect(Object.keys(build(ORG))).toEqual(["joos_evaluation_slots"]);
    expect(Object.keys(build(OTHER_ORG))).toEqual([]);
  });
});
