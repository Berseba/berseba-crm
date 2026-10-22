import { describe, expect, it } from "vitest";

import { extrairOrigemDaPagina, montarCodigoDeOrigemDoSite } from "@/lib/leads/origem-do-site";
import { buttonText, MAX_BUTTON_TEXT_LENGTH } from "@/lib/plataformas-de-anuncio/button-text";
import { PADRAO_DO_REF } from "@/lib/plataformas-de-anuncio/captura-de-clique";

const ANY_MARKER = /\[(ref|dk1):[^\]]*\]/i;

describe("buttonText", () => {
  it("keeps a plain message as is", () => {
    expect(buttonText("Quero agendar uma avaliação")).toBe("Quero agendar uma avaliação");
  });

  it("removes every [ref:...] and [dk1:...] marker, in any case", () => {
    expect(buttonText("Olá! Vim pelo site. [ref:K7M2P9]")).toBe("Olá! Vim pelo site.");
    expect(buttonText("[REF:K7M2P9] Olá [Ref:AAAAAA] tudo bem?")).toBe("Olá tudo bem?");
    expect(buttonText("Oi [dk1:eyJ1dG1fc291cmNlIjoibWV0YSJ9] aqui")).toBe("Oi aqui");
    expect(buttonText("[DK1:abc_-123][ref:ZZZZZZ]Oi")).toBe("Oi");
    // An empty marker is still a marker.
    expect(buttonText("Oi [ref:]")).toBe("Oi");
  });

  it("leaves brackets that are not attribution markers", () => {
    expect(buttonText("Quero o plano [mensal] e [ref sem dois pontos]")).toBe(
      "Quero o plano [mensal] e [ref sem dois pontos]",
    );
  });

  it("collapses runs of whitespace into one space and trims", () => {
    expect(buttonText("  Olá \n\n  tudo\t bem?  ")).toBe("Olá tudo bem?");
  });

  it("preserves accents and unicode", () => {
    expect(buttonText("Olá, gestante de 20 semanas 🤰 quero saber da avaliação")).toBe(
      "Olá, gestante de 20 semanas 🤰 quero saber da avaliação",
    );
  });

  it("caps the message by code points, never splitting an emoji", () => {
    const texto = "🤰".repeat(MAX_BUTTON_TEXT_LENGTH + 50);
    const resultado = buttonText(texto)!;
    expect(Array.from(resultado)).toHaveLength(MAX_BUTTON_TEXT_LENGTH);
    expect(resultado).toBe("🤰".repeat(MAX_BUTTON_TEXT_LENGTH));
  });

  it("caps at exactly 300 and leaves 300 untouched", () => {
    expect(MAX_BUTTON_TEXT_LENGTH).toBe(300);
    expect(buttonText("a".repeat(300))).toBe("a".repeat(300));
    expect(buttonText("a".repeat(301))).toBe("a".repeat(300));
  });

  it("does not leave a trailing space where the cap cut", () => {
    const resultado = buttonText(`${"a".repeat(299)} bbbb`);
    expect(resultado).toBe("a".repeat(299));
  });

  it("caps after the markers are removed, not before", () => {
    expect(buttonText(`[ref:K7M2P9]${"a".repeat(300)}`)).toBe("a".repeat(300));
  });

  it.each([null, "", "   ", "\n\t", "[ref:K7M2P9]", " [dk1:abc] [ref:ZZZZZZ] "])(
    "nothing left to send (%j) is null",
    (entrada) => {
      expect(buttonText(entrada)).toBeNull();
    },
  );
});

describe("buttonText: markers built by nesting", () => {
  // Removing one marker can close up the pieces of another.
  const NESTED_REF = "[re[ref:]f:ABCDEF]"; // -> [ref:ABCDEF]
  const NESTED_DK1_PAYLOAD = montarCodigoDeOrigemDoSite({ utm_source: "evil" })!; // [dk1:...]
  const NESTED_DK1 = `[dk${"[dk1:]"}${NESTED_DK1_PAYLOAD.slice("[dk".length)}`; // [dk[dk1:]1:...]
  const TRIPLE = "[re[r[ref:]ef:]f:ABCDEF]"; // -> [re[ref:]f:ABCDEF] -> [ref:ABCDEF]

  it("the fixtures really are what they claim", () => {
    // A single pass over each of them leaves a valid marker: the bypass.
    const singlePass = (text: string) => text.replace(/\[(ref|dk1):[^\]]*\]/gi, "");
    expect(singlePass(NESTED_REF)).toBe("[ref:ABCDEF]");
    expect(extrairOrigemDaPagina(singlePass(NESTED_DK1))).not.toBeNull();
    expect(singlePass(TRIPLE)).toBe("[re[ref:]f:ABCDEF]");
    expect(singlePass(singlePass(TRIPLE))).toBe("[ref:ABCDEF]");
  });

  it("a nested [ref:...] is removed whole", () => {
    expect(buttonText(NESTED_REF)).toBeNull();
    expect(buttonText(`Oi ${NESTED_REF} tudo bem?`)).toBe("Oi tudo bem?");
  });

  it("a nested [dk1:...] is removed whole, so the inbound side reads no origin from it", () => {
    expect(buttonText(NESTED_DK1)).toBeNull();
    const resultado = buttonText(`Oi ${NESTED_DK1} tudo bem?`);
    expect(resultado).toBe("Oi tudo bem?");
    expect(extrairOrigemDaPagina(resultado)).toBeNull();
  });

  it("a triple nesting is removed whole", () => {
    expect(buttonText(TRIPLE)).toBeNull();
    expect(buttonText(`Oi ${TRIPLE} tudo bem?`)).toBe("Oi tudo bem?");
  });

  it("nesting in both marker kinds at once, in any case", () => {
    expect(buttonText("Oi [DK[Ref:]1:abc] [R[dk1:]EF:ZZZZZZ] fim")).toBe("Oi fim");
  });

  it("nesting too deep to be a message is refused, not half stripped", () => {
    let nested = "[ref:ABCDEF]";
    for (let i = 0; i < 50; i += 1) nested = `[re${nested}f:]`;
    // Wrapping a marker in the pieces of another: each pass peels one level.
    expect(buttonText(`Oi ${nested}`)).toBeNull();
  });

  it("never lets a marker through, whatever is nested where (seeded fuzz)", () => {
    let seed = 20261020;
    const next = (limit: number) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed % limit;
    };
    const pieces = ["[ref:]", "[dk1:]", "[REF:AAAAAA]", "[Dk1:abc_-]", "[ref:K7M2P9]"];
    for (let round = 0; round < 500; round += 1) {
      let text = pieces[next(pieces.length)]!;
      for (let depth = next(5); depth >= 0; depth -= 1) {
        const at = next(text.length + 1);
        text = `${text.slice(0, at)}${pieces[next(pieces.length)]}${text.slice(at)}`;
      }
      const resultado = buttonText(`Oi ${text} fim`);
      expect(ANY_MARKER.test(resultado ?? ""), `${JSON.stringify(text)} -> ${resultado}`).toBe(
        false,
      );
    }
  });

  it("the cap cannot build a marker: an unterminated one at the end stays unreadable", () => {
    const resultado = buttonText(`${"a".repeat(290)} [ref:ABCDEF`)!;
    expect(Array.from(resultado).length).toBeLessThanOrEqual(MAX_BUTTON_TEXT_LENGTH);
    expect(ANY_MARKER.test(resultado)).toBe(false);
    expect(PADRAO_DO_REF.test(resultado)).toBe(false);
  });
});
