/**
 * Berseba: the salon's ofertas (what the agent books alone) and the choice of options.
 */
import { describe, expect, it } from "vitest";

import type { AvecSlot } from "./client";
import {
  escolherOpcoes,
  etapasDe,
  montarOpcoes,
  ofertaPorId,
  salaoDa,
  servicosAvulsos,
  validarOpcao,
  type Opcao,
} from "./ofertas";

const salao = salaoDa("E054EE97-00A7-42FD-9701-279AFC04A74C")!;
const oferta = (id: string) => ofertaPorId(salao, id)!;

function slot(prof: string, service: string, date: string, start: string, minutes = 30): AvecSlot {
  const [h, m] = start.split(":").map(Number) as [number, number];
  const end = h * 60 + m + minutes;
  return {
    id: `${prof}-${service}-${date}-${start.replace(":", "")}`,
    professional_id: prof,
    service_id: service,
    date,
    start_time: start,
    end_time: `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`,
    starts_at: `${date}T${start}:00-03:00`,
    bookings_that_day: 2,
    gap_before_minutes: null,
    gap_after_minutes: null,
  };
}

const opcao = (
  data: string,
  inicio: string,
  agrupamento: 0 | 1 | 2,
  profissional = "p",
): Opcao => ({
  opcao_id: `${data}-${inicio}-${profissional}`,
  data,
  inicio,
  fim: inicio,
  profissional,
  agrupamento,
});

describe("salon", () => {
  it("only the Mayara Morales organization books alone", () => {
    expect(salaoDa("99999999-9999-4999-8999-999999999999")).toBeNull();
  });

  it("no oferta is mechas, and Júlia never colours", () => {
    expect(salao.ofertas.some((o) => /mecha|morena|luzes/i.test(o.id + o.rotulo))).toBe(false);
    for (const id of ["tintura_raiz", "tonalizante", "tonalizante_raiz", "hidratacao"]) {
      expect(
        oferta(id).porProfissional.map((p) => p.profissional),
        id,
      ).not.toContain("797917");
    }
  });

  it("every step starts on the salon's 30-minute grid", () => {
    for (const o of salao.ofertas) {
      for (const p of o.porProfissional) {
        for (const c of [null, "curto", "medio", "longo", "extra_longo"] as const) {
          for (const e of etapasDe(o, p.profissional, c) ?? []) expect(e.inicio % 30, o.id).toBe(0);
        }
      }
    }
  });

  it("the toner's drying starts 1 h after it ends: +90 up to medium, +120 from long", () => {
    const steps = (c: "medio" | "longo") =>
      etapasDe(oferta("tonalizante"), "430008", c)!.map((e) => e.inicio);
    expect(steps("medio")).toEqual([0, 90]);
    expect(steps("longo")).toEqual([0, 120]);
  });

  it("the tintura's drying is 1h30 after the start", () => {
    expect(etapasDe(oferta("tintura_raiz"), "444096", "medio")).toEqual([
      { servico: "2181246", inicio: 0, papel: "principal" },
      { servico: "2129312", inicio: 90, papel: "auxiliar" },
    ]);
  });

  it("a length the salon has no service for stays with the team", () => {
    expect(etapasDe(oferta("reconstrucao"), "444099", "extra_longo")).toBeNull();
  });

  it("the agent changes alone only one-step services, never a corte with lavagem", () => {
    const avulsos = servicosAvulsos(salao);
    expect(avulsos.has("2129417")).toBe(true); // sobrancelha
    expect(avulsos.has("2128718")).toBe(true); // escova longa
    expect(avulsos.has("2128712")).toBe(false); // corte feminino (Mayara): always with lavagem
    expect(avulsos.has("2181246")).toBe(false); // tintura de raiz: with secagem
  });
});

describe("montarOpcoes", () => {
  it("the helper may be the colourist herself, unless her steps overlap", () => {
    // Júnior applies the tintura at 10:00 and dries at 11:30: no overlap, so he dries it.
    const slots = [
      slot("444091", "2181246", "2026-10-27", "10:00"),
      slot("444091", "2129312", "2026-10-27", "11:30"),
      slot("797917", "2129312", "2026-10-27", "11:30"),
    ];
    const [o] = montarOpcoes(salao, oferta("tintura_raiz"), ["444091"], "medio", slots);
    expect(o).toMatchObject({ profissional: "444091", auxiliar: "444091", fim: "12:00" });
  });

  it("no option when a step of the recipe has no free helper", () => {
    const slots = [slot("430008", "2128712", "2026-10-27", "10:00")];
    expect(
      montarOpcoes(salao, oferta("corte_feminino_com_secagem"), ["430008"], "medio", slots),
    ).toEqual([]);
  });

  it("a two-step sobrancelha needs both of Rebeca's half hours", () => {
    const slots = [
      slot("447142", "2129417", "2026-10-27", "10:00"),
      slot("447142", "2129318", "2026-10-27", "10:30"),
      slot("447142", "2129417", "2026-10-27", "15:00"),
    ];
    const opcoes = montarOpcoes(salao, oferta("sobrancelha_com_henna"), ["447142"], null, slots);
    expect(opcoes.map((o) => [o.inicio, o.fim])).toEqual([["10:00", "11:00"]]);
    expect(validarOpcao(salao, opcoes[0]!.opcao_id)).toMatchObject({ principal: "447142" });
  });
});

describe("escolherOpcoes", () => {
  const hoje = "2026-10-23"; // a Friday

  it("next to her clients first, then a day she works, at most 3 and 2 a day", () => {
    const r = escolherOpcoes(
      [
        opcao("2026-10-27", "09:00", 1),
        opcao("2026-10-27", "14:00", 0),
        opcao("2026-10-27", "15:00", 0),
        opcao("2026-10-27", "16:00", 0),
        opcao("2026-10-28", "10:00", 1),
      ],
      {},
      hoje,
    );
    expect(r.map((o) => [o.data, o.inicio])).toEqual([
      ["2026-10-27", "14:00"],
      ["2026-10-27", "15:00"],
      ["2026-10-28", "10:00"],
    ]);
  });

  it("an empty day only when the client asked for that day", () => {
    const vazio = opcao("2026-10-28", "10:00", 2);
    expect(escolherOpcoes([vazio], {}, hoje)).toEqual([]);
    expect(escolherOpcoes([vazio], { dias_semana: ["quarta"] }, hoje)).toEqual([vazio]);
    expect(escolherOpcoes([vazio], { data: "2026-10-28" }, hoje)).toEqual([vazio]);
  });

  it("the client's day, period and time come before the convention", () => {
    const opcoes = [
      opcao("2026-10-24", "09:00", 0),
      opcao("2026-10-24", "13:00", 1),
      opcao("2026-10-24", "16:00", 1),
      opcao("2026-10-27", "15:00", 0),
    ];
    expect(
      escolherOpcoes(opcoes, { dias_semana: ["sabado"], periodo: "tarde" }, hoje).map(
        (o) => o.inicio,
      ),
    ).toEqual(["13:00", "16:00"]);
    expect(escolherOpcoes(opcoes, { horario: "15:30" }, hoje)[0]!.inicio).toMatch(/^1[56]:00$/);
  });

  it("this week before next week", () => {
    const r = escolherOpcoes(
      [opcao("2026-10-31", "10:00", 0), opcao("2026-10-28", "10:00", 1)],
      {},
      hoje,
    );
    expect(r.map((o) => o.data)).toEqual(["2026-10-28", "2026-10-31"]);
  });

  it("the same time twice (two professionals) is offered once", () => {
    const r = escolherOpcoes(
      [opcao("2026-10-27", "10:00", 0, "a"), opcao("2026-10-27", "10:00", 0, "b")],
      {},
      hoje,
    );
    expect(r).toHaveLength(1);
  });
});
