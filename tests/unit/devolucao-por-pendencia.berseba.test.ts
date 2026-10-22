import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clienteAguardandoEquipe,
  decidirDevolucao,
  devolverAoAgenteSePrazoVenceu,
  filtrarClienteAguardando,
  type Pendencia,
} from "@/lib/escalacao/devolucao-por-pendencia.berseba";
import type { ConversaEmHandoff } from "@/lib/escalacao/devolucao-automatica";

/**
 * Berseba: who owes the reply decides when a conversation held by a person
 * goes back to the agent. See the header of
 * `lib/escalacao/devolucao-por-pendencia.berseba.ts`.
 *
 * The real case behind it (Mayara Morales salon, 20/10): the agent handed
 * Patricia to the team. Ruth replied at 17:09 and closed at 17:10. Patricia
 * wrote again at 17:41, and the conversation reopened with no owner and the
 * agent muted. Nobody answered her for 20 h.
 */

const devolver = vi.fn();
const logInfo = vi.fn();
const logWarn = vi.fn();

vi.mock("@/lib/escalacao/retomada", () => ({
  devolverAtendimentoAoAgente: (...a: unknown[]) => devolver(...a),
}));
vi.mock("@/lib/logger", () => ({
  logger: {
    info: (...a: unknown[]) => logInfo(...a),
    warn: (...a: unknown[]) => logWarn(...a),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const H = 3_600_000;
const T0 = Date.parse("2026-10-20T20:10:00Z"); // Ruth closed (17:10 in São Paulo)

function pendencia(p: Partial<Pendencia>): Pendencia {
  return {
    ultimaRespostaHumanaMs: null,
    fechadaEmMs: null,
    ultimaPassagemMs: null,
    ultimaMensagemDoClienteMs: null,
    ...p,
  };
}

describe("the rule", () => {
  const patricia = pendencia({
    ultimaPassagemMs: T0 - 6 * H, // the agent handed her off at 11:26
    ultimaMensagemDoClienteMs: T0 - 6 * H + 60_000, // "...fazer uma escova?" at 11:27
    ultimaRespostaHumanaMs: T0 - 60_000, // Ruth at 17:09
    fechadaEmMs: T0, // Ruth closed at 17:10
  });

  it("Patricia writes 31 min after the close: inside 24 h, the conversation stays with the team", () => {
    expect(decidirDevolucao(patricia, 1440, T0 + 31 * 60_000)).toEqual({
      devolver: false,
      motivo: "dentro_do_prazo",
    });
  });

  it("the same client writes 25 h after the close: back to the agent", () => {
    expect(decidirDevolucao(patricia, 1440, T0 + 25 * H)).toEqual({ devolver: true });
  });

  it("the client wrote after the team's last reply: she is waiting, never returned, however long", () => {
    const aguardando = pendencia({
      ultimaRespostaHumanaMs: T0,
      ultimaMensagemDoClienteMs: T0 + 5 * 60_000,
    });
    expect(clienteAguardandoEquipe(aguardando)).toBe(true);
    expect(decidirDevolucao(aguardando, 1440, T0 + 10 * 24 * H)).toEqual({
      devolver: false,
      motivo: "cliente_aguardando",
    });
  });

  it("a handoff nobody answered is the team's debt", () => {
    expect(
      decidirDevolucao(pendencia({ ultimaPassagemMs: T0 }), 1440, T0 + 3 * 24 * H),
    ).toEqual({ devolver: false, motivo: "cliente_aguardando" });
  });

  it("a handoff after the team's last reply is a new debt", () => {
    const novaPassagem = pendencia({ ultimaRespostaHumanaMs: T0, ultimaPassagemMs: T0 + H });
    expect(clienteAguardandoEquipe(novaPassagem)).toBe(true);
  });

  it("closing settles a client's last 'obrigada': the clock runs from the close", () => {
    const obrigada = pendencia({
      ultimaRespostaHumanaMs: T0 - 2 * H,
      ultimaMensagemDoClienteMs: T0 - H,
      fechadaEmMs: T0,
    });
    expect(clienteAguardandoEquipe(obrigada)).toBe(false);
    expect(decidirDevolucao(obrigada, 1440, T0 + 23 * H).devolver).toBe(false);
    expect(decidirDevolucao(obrigada, 1440, T0 + 24 * H).devolver).toBe(true);
  });
});

// ── A fake PostgREST: each read answers from the table and the filters asked ──

type Filtro = [metodo: string, ...args: unknown[]];
interface Leitura {
  tabela: string;
  filtros: Filtro[];
}
let leituras: Leitura[];
let responder: (l: Leitura) => { data: unknown; error: { message: string } | null };

function admin() {
  return {
    from(tabela: string) {
      const leitura: Leitura = { tabela, filtros: [] };
      leituras.push(leitura);
      const chain: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              return (ok: (v: unknown) => void, falha: (e: unknown) => void) => {
                try {
                  ok(responder(leitura));
                } catch (e) {
                  falha(e);
                }
              };
            }
            return (...args: unknown[]) => {
              leitura.filtros.push([prop, ...args]);
              return chain;
            };
          },
        },
      );
      return chain;
    },
  } as never;
}

const tem = (l: Leitura, ...f: Filtro) =>
  l.filtros.some((x) => x.length === f.length && x.every((v, i) => v === f[i]));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const SESSAO = "44444444-4444-4444-8444-444444444444";
const MENSAGEM = "55555555-5555-4555-8555-555555555555";

const iso = (ms: number) => new Date(ms).toISOString();

interface Cenario {
  settings: unknown;
  conversa: Record<string, unknown> | null;
  contato: Record<string, unknown> | null;
  agentePublicadoNaSessao: boolean;
  ultimaRespostaHumana: number | null;
  ultimaMensagemDoCliente: number | null;
  falhaEm?: string;
}
let cenario: Cenario;

function responderCenario(l: Leitura) {
  if (cenario.falhaEm === l.tabela) return { data: null, error: { message: "boom" } };
  switch (l.tabela) {
    case "organizations":
      return { data: { settings: cenario.settings }, error: null };
    case "conversations":
      return { data: cenario.conversa, error: null };
    case "contacts":
      return { data: cenario.contato, error: null };
    case "ai_agents":
      return {
        data: [
          {
            ai_agent_versions: {
              channel_session_id: cenario.agentePublicadoNaSessao ? SESSAO : "outra-sessao",
              status: "published",
            },
          },
        ],
        error: null,
      };
    case "ai_routers":
      return { data: [], error: null };
    case "messages": {
      const humana = tem(l, "eq", "sent_via", "user");
      const ms = humana ? cenario.ultimaRespostaHumana : cenario.ultimaMensagemDoCliente;
      return { data: ms === null ? null : { sent_at: iso(ms) }, error: null };
    }
    default:
      throw new Error(`unexpected table ${l.tabela}`);
  }
}

const ENTRADA = {
  organizationId: ORG,
  contactId: CONTATO,
  conversationId: CONVERSA,
  messageId: MENSAGEM,
  requestId: "req-1",
};

beforeEach(() => {
  devolver.mockReset();
  devolver.mockResolvedValue({ ok: true });
  logInfo.mockReset();
  logWarn.mockReset();
  leituras = [];
  responder = responderCenario;
  // Patricia, reopened 25 h after Ruth closed: with the person, deadline passed.
  cenario = {
    settings: { routing: { handoff_return_after_minutes: 1440, conversation_stays_with_attendant: true } },
    conversa: {
      id: CONVERSA,
      organization_id: ORG,
      channel_session_id: SESSAO,
      status: "claimed",
      assignee_kind: "user",
      assigned_to_user_id: "ruth",
      assigned_at: iso(T0 + 25 * H),
      bot_silenced_until: "infinity",
      last_handoff_at: iso(T0 - 6 * H),
      last_outbound_at: iso(T0 - 60_000),
      status_changed_at: iso(T0 + 25 * H),
      service_closed_at: iso(T0),
      is_group: false,
    },
    contato: { force_human: true, is_blocked: false },
    agentePublicadoNaSessao: true,
    ultimaRespostaHumana: T0 - 60_000,
    ultimaMensagemDoCliente: T0 - 6 * H + 60_000,
  };
});

describe("when the client writes", () => {
  it("deadline passed and nothing pending: returns to the agent, with the automatic origin", async () => {
    await devolverAoAgenteSePrazoVenceu(admin(), ENTRADA, T0 + 25 * H);

    expect(devolver).toHaveBeenCalledTimes(1);
    expect(devolver.mock.calls[0]?.[1]).toEqual({
      conversationId: CONVERSA,
      origem: { automatica: { minutos: 1440 } },
    });
    expect(devolver.mock.calls[0]?.[0]).toMatchObject({
      organizationId: ORG,
      actor: { type: "webhook_source" },
      requestId: "req-1",
    });
  });

  it("the message being ingested does not count as pending, and only CRM replies count as the team's", async () => {
    await devolverAoAgenteSePrazoVenceu(admin(), ENTRADA, T0 + 25 * H);

    const mensagens = leituras.filter((l) => l.tabela === "messages");
    const doCliente = mensagens.find((l) => tem(l, "eq", "direction", "inbound"));
    const daEquipe = mensagens.find((l) => tem(l, "eq", "direction", "outbound"));
    expect(doCliente && tem(doCliente, "neq", "id", MENSAGEM)).toBe(true);
    expect(daEquipe && tem(daEquipe, "eq", "sent_via", "user")).toBe(true);
    for (const l of [...mensagens, ...leituras.filter((x) => x.tabela !== "ai_agents")]) {
      expect(tem(l, "eq", "organization_id", ORG) || tem(l, "eq", "id", ORG)).toBe(true);
    }
  });

  it("inside the deadline (Patricia at 17:41): stays with the person", async () => {
    await devolverAoAgenteSePrazoVenceu(admin(), ENTRADA, T0 + 31 * 60_000);
    expect(devolver).not.toHaveBeenCalled();
  });

  it("the client was already waiting: stays with the person", async () => {
    cenario.ultimaMensagemDoCliente = T0 + H;
    await devolverAoAgenteSePrazoVenceu(admin(), ENTRADA, T0 + 3 * 24 * H);
    expect(devolver).not.toHaveBeenCalled();
  });

  it("no deadline configured: reads only the organization, nothing changes", async () => {
    cenario.settings = { routing: { handoff_return_after_minutes: null } };
    await devolverAoAgenteSePrazoVenceu(admin(), ENTRADA, T0 + 25 * H);
    expect(devolver).not.toHaveBeenCalled();
    expect(leituras.map((l) => l.tabela)).toEqual(["organizations"]);
  });

  it("the agent already holds the conversation: nothing to do", async () => {
    cenario.conversa = {
      ...cenario.conversa,
      status: "ai_handling",
      assignee_kind: "ai",
      assigned_to_user_id: null,
      bot_silenced_until: null,
    };
    cenario.contato = { force_human: false, is_blocked: false };
    await devolverAoAgenteSePrazoVenceu(admin(), ENTRADA, T0 + 25 * H);
    expect(devolver).not.toHaveBeenCalled();
  });

  it("only the contact's force_human is left: still returns", async () => {
    cenario.conversa = {
      ...cenario.conversa,
      status: "open",
      assignee_kind: null,
      assigned_to_user_id: null,
      bot_silenced_until: null,
    };
    await devolverAoAgenteSePrazoVenceu(admin(), ENTRADA, T0 + 25 * H);
    expect(devolver).toHaveBeenCalledTimes(1);
  });

  it("a blocked contact is never returned", async () => {
    cenario.contato = { force_human: true, is_blocked: true };
    await devolverAoAgenteSePrazoVenceu(admin(), ENTRADA, T0 + 25 * H);
    expect(devolver).not.toHaveBeenCalled();
  });

  it("no agent on the session: stays with the person, nobody else would answer", async () => {
    cenario.agentePublicadoNaSessao = false;
    await devolverAoAgenteSePrazoVenceu(admin(), ENTRADA, T0 + 25 * H);
    expect(devolver).not.toHaveBeenCalled();
  });

  it("a read error never throws and keeps the conversation with the person", async () => {
    cenario.falhaEm = "messages";
    await expect(devolverAoAgenteSePrazoVenceu(admin(), ENTRADA, T0 + 25 * H)).resolves.toBeUndefined();
    expect(devolver).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalled();
  });

  it("a failed return never throws", async () => {
    devolver.mockRejectedValue(new Error("db down"));
    await expect(devolverAoAgenteSePrazoVenceu(admin(), ENTRADA, T0 + 25 * H)).resolves.toBeUndefined();
  });
});

describe("the cron's guard", () => {
  const vencida = (id: string): { conversa: ConversaEmHandoff; minutos: number } => ({
    conversa: { ...(cenario.conversa as unknown as ConversaEmHandoff), id },
    minutos: 1440,
  });

  it("keeps the conversation the team answered last, drops the one whose client is waiting", async () => {
    responder = (l) => {
      if (l.tabela === "conversations") {
        const id = l.filtros.find((f) => f[0] === "eq" && f[1] === "id")?.[2];
        return {
          data: { id, service_closed_at: null, last_handoff_at: iso(T0 - 6 * H) },
          error: null,
        };
      }
      if (l.tabela === "messages") {
        const conv = l.filtros.find((f) => f[0] === "eq" && f[1] === "conversation_id")?.[2];
        const humana = tem(l, "eq", "sent_via", "user");
        // "respondida": Ruth replied last. "aguardando": the client wrote after Ruth (#58).
        const ms = humana ? T0 : conv === "aguardando" ? T0 + H : T0 - H;
        return { data: { sent_at: iso(ms) }, error: null };
      }
      throw new Error(`unexpected table ${l.tabela}`);
    };

    const out = await filtrarClienteAguardando(
      admin(),
      [vencida("respondida"), vencida("aguardando")],
      T0 + 25 * H,
    );
    expect(out.map((v) => v.conversa.id)).toEqual(["respondida"]);
  });

  it("a read error keeps the conversation with the person", async () => {
    responder = () => ({ data: null, error: { message: "boom" } });
    expect(await filtrarClienteAguardando(admin(), [vencida("x")], T0 + 25 * H)).toEqual([]);
  });
});

describe("wiring", () => {
  const ler = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

  it("the ingestion runs the check after opt-out and before the lead and the dispatch", () => {
    const fonte = ler("lib/channels/pos-entrada.ts");
    const corpo = fonte.slice(fonte.indexOf("export async function aplicarEfeitosPosEntrada"));
    const checagem = corpo.indexOf("await devolverAoAgenteSePrazoVenceu(admin, entrada)");
    expect(checagem).toBeGreaterThan(corpo.indexOf("await aplicarOptOut(admin, entrada)"));
    expect(checagem).toBeLessThan(corpo.indexOf("await abrirDemanda(admin, entrada)"));
    expect(checagem).toBeLessThan(corpo.indexOf("await pedirDespachoDoAgente(admin, entrada)"));
  });

  it("the cron filters the expired conversations before returning any", () => {
    const fonte = ler("app/api/v1/cron/handoff-devolucao/route.ts");
    const filtro = fonte.indexOf("await filtrarClienteAguardando(admin, selecionarVencidas(");
    expect(filtro).toBeGreaterThan(-1);
    expect(filtro).toBeLessThan(fonte.indexOf("for (const { conversa, minutos } of vencidas)"));
  });
});
