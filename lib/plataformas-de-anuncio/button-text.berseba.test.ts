import { describe, expect, it } from "vitest";

import { buttonText, MAX_BUTTON_TEXT_LENGTH } from "@/lib/plataformas-de-anuncio/button-text";

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
