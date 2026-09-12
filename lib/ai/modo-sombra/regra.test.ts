import { describe, expect, it } from "vitest";

import { decidirModoSombra } from "./regra";

describe("decidirModoSombra", () => {
  it("nenhum ligado: não é sombra", () => {
    expect(decidirModoSombra({ org: false, canal: false, agente: false })).toEqual({
      sombra: false,
      origem: null,
    });
  });

  it("só a organização: sombra, origem 'organizacao'", () => {
    expect(decidirModoSombra({ org: true, canal: false, agente: false })).toEqual({
      sombra: true,
      origem: "organizacao",
    });
  });

  it("só o canal: sombra, origem 'canal'", () => {
    expect(decidirModoSombra({ org: false, canal: true, agente: false })).toEqual({
      sombra: true,
      origem: "canal",
    });
  });

  it("só o agente (já 'assisted'): sombra, origem 'agente'", () => {
    expect(decidirModoSombra({ org: false, canal: false, agente: true })).toEqual({
      sombra: true,
      origem: "agente",
    });
  });

  it("organização + canal: sombra, origem 'organizacao' (primeira na ordem)", () => {
    expect(decidirModoSombra({ org: true, canal: true, agente: false })).toEqual({
      sombra: true,
      origem: "organizacao",
    });
  });

  it("canal + agente (sem org): sombra, origem 'canal'", () => {
    expect(decidirModoSombra({ org: false, canal: true, agente: true })).toEqual({
      sombra: true,
      origem: "canal",
    });
  });

  it("todos ligados: sombra, origem 'organizacao'", () => {
    expect(decidirModoSombra({ org: true, canal: true, agente: true })).toEqual({
      sombra: true,
      origem: "organizacao",
    });
  });
});
