/**
 * Berseba: which free slot serves which waitlist entry, the order of the queue and the offer text.
 */
import { describe, expect, it } from "vitest";

import type { ConfigDaListaDeEspera } from "@/lib/agenda/lista-de-espera";

import {
  chaveDaVaga,
  horaPorExtenso,
  janelaDeBusca,
  motivoParaNaoServir,
  ocupacaoDa,
  ordenarFilaAvec,
  prazoDaOfertaAvec,
  quandoPorExtenso,
  sobrepoe,
  textoDaOfertaAvec,
  vagaParaInscricao,
  type InscricaoAvec,
} from "./lista-de-espera";
import type { Opcao } from "./ofertas";

const config: ConfigDaListaDeEspera = {
  ativa: true,
  prazo_maximo_minutos: 120,
  margem_antes_minutos: 120,
  prazo_minimo_minutos: 30,
};

// Monday 2026-12-14 09:00 in Brasília.
const agora = new Date("2026-12-14T12:00:00Z");

function inscricao(over: Partial<InscricaoAvec> = {}): InscricaoAvec {
  return {
    id: "e1",
    contactId: "c1",
    pedido: { servico: "escova", comprimento: "medio", profissional: null },
    dataDe: "2026-12-15",
    dataAte: "2026-12-20",
    depoisDe: null,
    ate: null,
    substituiData: null,
    ordem: 1,
    createdAt: new Date("2026-12-01T12:00:00Z"),
    recusadas: [],
    ...over,
  };
}

function opcao(data: string, inicio: string, fim: string, profissional = "mayara", auxiliar?: string): Opcao {
  return {
    opcao_id: `escova:medio:${profissional}-s-${data}-${inicio.replace(":", "")}`,
    data,
    inicio,
    fim,
    profissional,
    ...(auxiliar ? { auxiliar } : {}),
    agrupamento: 0,
  };
}

describe("janelaDeBusca", () => {
  it("starts today when the entry started before", () => {
    expect(janelaDeBusca(inscricao({ dataDe: "2026-12-10" }), "2026-12-14")).toEqual({
      de: "2026-12-14",
      ate: "2026-12-20",
    });
  });

  it("only looks before the visit she wants to move", () => {
    expect(janelaDeBusca(inscricao({ substituiData: "2026-12-18" }), "2026-12-14")).toEqual({
      de: "2026-12-15",
      ate: "2026-12-17",
    });
  });

  it("caps the search at 14 days per avec call", () => {
    expect(janelaDeBusca(inscricao({ dataAte: "2027-01-30" }), "2026-12-14")?.ate).toBe("2026-12-28");
  });

  it("is null when the dates are over or the visit is the first day", () => {
    expect(janelaDeBusca(inscricao({ dataAte: "2026-12-13" }), "2026-12-14")).toBeNull();
    expect(janelaDeBusca(inscricao({ substituiData: "2026-12-15" }), "2026-12-14")).toBeNull();
  });
});

describe("motivoParaNaoServir", () => {
  it("accepts a slot inside the dates and the time window", () => {
    const e = inscricao({ depoisDe: "14:00", ate: "18:00" });
    expect(motivoParaNaoServir(e, opcao("2026-12-16", "15:00", "16:00"), [], agora, config)).toBeNull();
  });

  it("refuses a slot outside the dates", () => {
    expect(motivoParaNaoServir(inscricao(), opcao("2026-12-21", "15:00", "16:00"), [], agora, config)).toBe(
      "fora_das_datas",
    );
  });

  it("compares the START with the time window", () => {
    const e = inscricao({ depoisDe: "14:00", ate: "18:00" });
    expect(motivoParaNaoServir(e, opcao("2026-12-16", "13:30", "14:30"), [], agora, config)).toBe("fora_do_horario");
    expect(motivoParaNaoServir(e, opcao("2026-12-16", "18:30", "19:30"), [], agora, config)).toBe("fora_do_horario");
    expect(motivoParaNaoServir(e, opcao("2026-12-16", "18:00", "19:00"), [], agora, config)).toBeNull();
  });

  it("never offers again the slot she refused", () => {
    const o = opcao("2026-12-16", "15:00", "16:00");
    expect(motivoParaNaoServir(inscricao({ recusadas: [chaveDaVaga(o)] }), o, [], agora, config)).toBe("ja_recusada");
  });

  it("skips a slot held for someone else, including the helper's time", () => {
    const held = ocupacaoDa(opcao("2026-12-16", "15:00", "16:30", "gi", "julia"));
    expect(
      motivoParaNaoServir(inscricao(), opcao("2026-12-16", "16:00", "17:00", "julia"), held, agora, config),
    ).toBe("segurada_para_outra");
    expect(motivoParaNaoServir(inscricao(), opcao("2026-12-16", "16:30", "17:30", "julia"), held, agora, config)).toBeNull();
  });

  it("does not offer a slot too close to answer in time", () => {
    // 11:00 today: the margin (2 h) leaves 0 min to answer.
    const e = inscricao({ dataDe: "2026-12-14" });
    expect(motivoParaNaoServir(e, opcao("2026-12-14", "11:00", "12:00"), [], agora, config)).toBe("perto_demais");
  });
});

describe("vagaParaInscricao", () => {
  it("offers the earliest option that serves her", () => {
    const e = inscricao({ depoisDe: "14:00" });
    const escolhida = vagaParaInscricao(
      e,
      [opcao("2026-12-17", "15:00", "16:00"), opcao("2026-12-16", "10:00", "11:00"), opcao("2026-12-16", "16:00", "17:00")],
      [],
      agora,
      config,
    );
    expect(escolhida?.data).toBe("2026-12-16");
    expect(escolhida?.inicio).toBe("16:00");
  });

  it("is null when nothing serves", () => {
    expect(vagaParaInscricao(inscricao(), [opcao("2026-12-25", "15:00", "16:00")], [], agora, config)).toBeNull();
  });
});

describe("sobrepoe", () => {
  it("needs the same person, the same day and crossing times", () => {
    const a = [{ profissional: "gi", data: "2026-12-16", inicio: 600, fim: 660 }];
    expect(sobrepoe(a, [{ profissional: "gi", data: "2026-12-16", inicio: 630, fim: 700 }])).toBe(true);
    expect(sobrepoe(a, [{ profissional: "gi", data: "2026-12-16", inicio: 660, fim: 700 }])).toBe(false);
    expect(sobrepoe(a, [{ profissional: "julia", data: "2026-12-16", inicio: 630, fim: 700 }])).toBe(false);
    expect(sobrepoe(a, [{ profissional: "gi", data: "2026-12-17", inicio: 630, fim: 700 }])).toBe(false);
  });
});

describe("ordenarFilaAvec", () => {
  it("follows the team's order, then arrival", () => {
    const fila = ordenarFilaAvec([
      inscricao({ id: "b", ordem: 2 }),
      inscricao({ id: "c", ordem: 1, createdAt: new Date("2026-12-02T00:00:00Z") }),
      inscricao({ id: "a", ordem: 1 }),
    ]);
    expect(fila.map((e) => e.id)).toEqual(["a", "c", "b"]);
  });
});

describe("prazoDaOfertaAvec", () => {
  it("holds for the maximum when the slot is far", () => {
    expect(prazoDaOfertaAvec({ data: "2026-12-16", inicio: "15:00" }, agora, config)?.toISOString()).toBe(
      "2026-12-14T14:00:00.000Z",
    );
  });

  it("stops at the margin before the slot", () => {
    // Slot 12:00 today, margin 2 h → until 10:00 (1 h from now, above the 30 min minimum).
    expect(prazoDaOfertaAvec({ data: "2026-12-14", inicio: "12:00" }, agora, config)?.toISOString()).toBe(
      "2026-12-14T13:00:00.000Z",
    );
  });
});

describe("texts", () => {
  it("writes the day and the time as the salon says them", () => {
    expect(quandoPorExtenso({ data: "2026-12-19", inicio: "15:00" })).toBe("sábado, 19/12, às 15h");
    expect(quandoPorExtenso({ data: "2026-12-19", inicio: "09:30" })).toBe("sábado, 19/12, às 9h30");
    expect(horaPorExtenso(new Date("2026-12-14T20:00:00Z"))).toBe("17h");
    expect(horaPorExtenso(new Date("2026-12-14T20:30:00Z"))).toBe("17h30");
  });

  it("writes the offer with the deadline and the swap", () => {
    const texto = textoDaOfertaAvec({
      nome: "Ana Paula Souza",
      servico: "Escova",
      profissional: "Mayara",
      opcao: { data: "2026-12-19", inicio: "15:00" },
      expiraEm: new Date("2026-12-14T20:00:00Z"),
      substituiData: "2026-12-23",
    });
    expect(texto).toBe(
      "Oi, Ana! Abriu um horário da lista de espera: sábado, 19/12, às 15h, Escova com Mayara. " +
        "Se quiser, eu troco pelo seu horário do dia 23/12. É seu se quiser! Me responde SIM até as 17h " +
        "que eu já deixo marcado e confirmado. Depois disso ele vai para a próxima pessoa da lista.",
    );
  });
});
