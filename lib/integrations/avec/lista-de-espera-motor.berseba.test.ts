/**
 * Berseba: the avec waitlist's flow — offer in the queue's order, one slot per person, the
 * deadline gives the slot to the next one, a message that did not go out releases the slot.
 */
import { describe, expect, it } from "vitest";

import type { ConfigDaListaDeEspera } from "@/lib/agenda/lista-de-espera";

import { chaveDaVaga, type InscricaoAvec, type Ocupacao } from "./lista-de-espera";
import {
  procurarVagas,
  rodadaDaEspera,
  type OfertaGuardada,
  type PortasDaEspera,
} from "./lista-de-espera-motor";
import type { Opcao } from "./ofertas";

const ORG = "org";
const config: ConfigDaListaDeEspera = {
  ativa: true,
  prazo_maximo_minutos: 120,
  margem_antes_minutos: 120,
  prazo_minimo_minutos: 30,
};
const agora = new Date("2026-12-14T12:00:00Z"); // Monday 09:00 in Brasília

type Linha = InscricaoAvec & {
  status: "waiting" | "offered";
  oferta: OfertaGuardada | null;
  chave: string | null;
  expira: Date | null;
};

function entrada(id: string, ordem: number, over: Partial<InscricaoAvec> = {}): Linha {
  return {
    id,
    contactId: `c-${id}`,
    pedido: { servico: "escova", comprimento: "medio", profissional: null },
    dataDe: "2026-12-15",
    dataAte: "2026-12-20",
    depoisDe: null,
    ate: null,
    substituiData: null,
    ordem,
    createdAt: new Date("2026-12-01T12:00:00Z"),
    recusadas: [],
    status: "waiting",
    oferta: null,
    chave: null,
    expira: null,
    ...over,
  };
}

function opcao(data: string, inicio: string, fim: string, profissional = "mayara"): Opcao {
  return { opcao_id: `escova:medio:${profissional}-x-${data}-${inicio.replace(":", "")}`, data, inicio, fim, profissional, agrupamento: 0 };
}

function montar(linhas: Linha[], livres: Opcao[], opts: { naoSai?: string[]; buscas?: string[] } = {}) {
  const enviados: Array<{ contato: string; texto: string }> = [];
  const portas: PortasDaEspera = {
    repo: {
      fila: async () => linhas.filter((l) => l.status === "waiting").map((l) => ({ ...l })),
      seguradas: async (_org, t) =>
        linhas
          .filter((l) => l.status === "offered" && l.expira! > t)
          .map((l) => ({ contactId: l.contactId, ocupacao: l.oferta!.ocupacao as Ocupacao[] })),
      ofertar: async (_org, id, oferta, chave, expiraEm) => {
        const l = linhas.find((x) => x.id === id)!;
        if (l.status !== "waiting") return false;
        if (linhas.some((x) => x.status === "offered" && x.chave === chave)) return false;
        Object.assign(l, { status: "offered", oferta, chave, expira: expiraEm });
        return true;
      },
      conflita: async (_org, id, contato, ocupacao, t) =>
        linhas.some(
          (x) =>
            x.id !== id &&
            x.status === "offered" &&
            x.expira! > t &&
            (x.contactId === contato ||
              x.oferta!.ocupacao.some((o) =>
                ocupacao.some((p) => o.profissional === p.profissional && o.data === p.data && o.inicio < p.fim && p.inicio < o.fim),
              )),
        ),
      voltarParaFila: async (_org, id, recusada) => {
        const l = linhas.find((x) => x.id === id)!;
        Object.assign(l, {
          status: "waiting",
          oferta: null,
          chave: null,
          expira: null,
          recusadas: recusada ? [...l.recusadas, recusada] : l.recusadas,
        });
      },
      vencidas: async (_org, t) =>
        linhas.filter((l) => l.status === "offered" && l.expira! <= t).map((l) => ({ id: l.id, chave: l.chave })),
      encerrarPassadas: async () => 0,
      nomeDoContato: async () => "Ana Paula",
    },
    canal: {
      podeAvisar: async () => true,
      avisar: async (_org, contato, texto) => {
        if (opts.naoSai?.includes(contato)) return false;
        enviados.push({ contato, texto });
        return true;
      },
    },
    agenda: {
      opcoes: async (pedido, de, ate) => {
        opts.buscas?.push(`${pedido.servico}:${de}:${ate}`);
        return livres.filter((o) => o.data >= de && o.data <= ate);
      },
      rotuloDoServico: () => "Escova",
      nomeDoProfissional: (id) => (id === "mayara" ? "Mayara" : null),
    },
  };
  return { portas, enviados };
}

describe("procurarVagas", () => {
  it("offers the slot to the first in the queue, and holds it from the next", async () => {
    const linhas = [entrada("b", 2), entrada("a", 1)];
    const { portas, enviados } = montar(linhas, [opcao("2026-12-16", "15:00", "16:00")]);
    const r = await procurarVagas(portas, ORG, config, agora);
    expect(r.ofertadas).toBe(1);
    expect(enviados.map((e) => e.contato)).toEqual(["c-a"]);
    // "Any professional": the salon never names who attends.
    expect(enviados[0]!.texto).toContain("quarta, 16/12, às 15h, Escova.");
    expect(enviados[0]!.texto).not.toContain("Mayara");
    expect(linhas.find((l) => l.id === "a")!.status).toBe("offered");
    expect(linhas.find((l) => l.id === "b")!.status).toBe("waiting");
  });

  it("names the professional only when she asked for one", async () => {
    const linhas = [entrada("a", 1, { pedido: { servico: "escova", comprimento: "medio", profissional: "mayara" } })];
    const { portas, enviados } = montar(linhas, [opcao("2026-12-16", "15:00", "16:00")]);
    await procurarVagas(portas, ORG, config, agora);
    expect(enviados[0]!.texto).toContain("Escova com Mayara.");
  });

  it("gives two different slots to two people in the same round", async () => {
    const linhas = [entrada("a", 1), entrada("b", 2)];
    const { portas, enviados } = montar(linhas, [
      opcao("2026-12-16", "15:00", "16:00"),
      opcao("2026-12-17", "10:00", "11:00"),
    ]);
    await procurarVagas(portas, ORG, config, agora);
    expect(enviados.map((e) => e.contato)).toEqual(["c-a", "c-b"]);
    expect(linhas.map((l) => l.oferta?.data)).toEqual(["2026-12-16", "2026-12-17"]);
  });

  it("releases the slot when the message did not go out, and the next one gets it", async () => {
    const linhas = [entrada("a", 1), entrada("b", 2)];
    const { portas, enviados } = montar(linhas, [opcao("2026-12-16", "15:00", "16:00")], { naoSai: ["c-a"] });
    await procurarVagas(portas, ORG, config, agora);
    expect(linhas.find((l) => l.id === "a")!.status).toBe("waiting");
    expect(enviados.map((e) => e.contato)).toEqual(["c-b"]);
  });

  it("searches avec once for two entries with the same request", async () => {
    const buscas: string[] = [];
    const linhas = [entrada("a", 1), entrada("b", 2)];
    const { portas } = montar(linhas, [], { buscas });
    await procurarVagas(portas, ORG, config, agora);
    expect(buscas).toEqual(["escova:2026-12-15:2026-12-20"]);
  });

  it("never sends two offers at once to the same client", async () => {
    const linhas = [
      entrada("a", 1),
      entrada("a2", 2, { contactId: "c-a", pedido: { servico: "corte", comprimento: null, profissional: null } }),
    ];
    const { portas, enviados } = montar(linhas, [
      opcao("2026-12-16", "15:00", "16:00"),
      opcao("2026-12-17", "10:00", "11:00"),
    ]);
    await procurarVagas(portas, ORG, config, agora);
    expect(enviados.map((e) => e.contato)).toEqual(["c-a"]);
    expect(linhas.find((l) => l.id === "a2")!.status).toBe("waiting");
  });

  it("can search one entry only", async () => {
    const linhas = [entrada("a", 1), entrada("b", 2)];
    const { portas, enviados } = montar(linhas, [opcao("2026-12-16", "15:00", "16:00")]);
    await procurarVagas(portas, ORG, config, agora, { soInscricao: "b" });
    expect(enviados.map((e) => e.contato)).toEqual(["c-b"]);
  });
});

describe("concurrent rounds", () => {
  it("a round that finds an overlapping offer made meanwhile yields before sending", async () => {
    const linhas = [entrada("a", 1), entrada("b", 2)];
    const { portas, enviados } = montar(linhas, [opcao("2026-12-16", "15:00", "16:00")]);
    // Another round held 15:30 with Mayara for someone else between our read and our hold.
    const outra = entrada("z", 9, { contactId: "c-z" });
    Object.assign(outra, {
      status: "offered",
      chave: "x",
      expira: new Date(agora.getTime() + 3_600_000),
      oferta: { ocupacao: [{ profissional: "mayara", data: "2026-12-16", inicio: 930, fim: 990 }] },
    });
    const seguradas = portas.repo.seguradas;
    portas.repo.seguradas = async (...args) => {
      const r = await seguradas(...args);
      linhas.push(outra);
      return r;
    };
    await procurarVagas(portas, ORG, config, agora);
    expect(enviados).toEqual([]);
    expect(linhas.find((l) => l.id === "a")!.status).toBe("waiting");
    expect(linhas.find((l) => l.id === "a")!.recusadas).toEqual([]);
  });
});

describe("rodadaDaEspera", () => {
  it("when the deadline passes, the slot goes to the next one and never back to her", async () => {
    const vaga = opcao("2026-12-16", "15:00", "16:00");
    const linhas = [entrada("a", 1), entrada("b", 2)];
    const { portas, enviados } = montar(linhas, [vaga]);
    await procurarVagas(portas, ORG, config, agora);
    expect(enviados.map((e) => e.contato)).toEqual(["c-a"]);

    const depois = new Date(agora.getTime() + 121 * 60_000);
    const r = await rodadaDaEspera(portas, ORG, config, depois);
    expect(r.vencidas).toBe(1);
    expect(enviados.map((e) => e.contato)).toEqual(["c-a", "c-b"]);
    const a = linhas.find((l) => l.id === "a")!;
    expect(a.status).toBe("waiting");
    expect(a.recusadas).toEqual([chaveDaVaga(vaga)]);
  });
});
