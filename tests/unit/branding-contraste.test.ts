import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DICROMACIAS,
  LIMIAR_ACROMATICO,
  PISOS,
  PISO_DE_CROMA,
  PISO_DE_SEPARACAO_DO_NEUTRO,
  PISO_DE_SEPARACAO_SIMULADA,
  ROTACAO_MAXIMA,
  deltaESimulado,
  derivarMarca,
  escolherAccent,
  extrairRegua,
  medirPares,
  melhorFrenteSobre,
  razaoDeContraste,
  reconciliarSemanticas,
  separacaoDoNeutro,
  simularDicromacia,
  superficiesDoTema,
} from "@/lib/branding/contraste";
import type { Regua, TemaDaRegua } from "@/lib/branding/contraste";
import { GRAUS, deltaEOklab, hexParaOklch, rampaDeSemente, stop } from "@/lib/branding/rampa";
import type { Rampa } from "@/lib/branding/rampa";

const RAIZ = process.cwd();
const CSS = fs.readFileSync(path.join(RAIZ, "app/globals.css"), "utf8");
const REGUA: Regua = extrairRegua(CSS);

const rampaChapada = (hex: string): Rampa =>
  Array.from({ length: 11 }, () => hex) as unknown as Rampa;

/** Os 11 `--color-accent-NNN` LITERAIS de um bloco do `globals.css`, na ordem de `GRAUS`. */
function rampaDeclarada(seletor: string): string[] {
  const inicio = CSS.indexOf(seletor);
  const bloco = CSS.slice(inicio, CSS.indexOf("\n}", inicio));
  return GRAUS.map((grau) => {
    const decl = new RegExp(`--color-accent-${grau}:\\s*([^;]+);`).exec(bloco);
    return /#[0-9a-f]{6}/i.exec(decl![1]!)![0]!.toLowerCase();
  });
}

/**
 * Fixture adversarial VERSIONADA. Não é amostra aleatória: cada semente foi posta aqui
 * por causar um modo de falha distinto.
 *
 *  `#0f172a`, `#1a1f36` — navy corporativa, croma baixíssimo (0,0398 e 0,0444); é onde
 *                         a ancoragem por lightness entrega outra cor ao cliente.
 *  `#f5c518`, `#f59e0b` — amarelo/âmbar: não alcançam 3:1 contra branco em NENHUM
 *                         universo, então forçam a caminhada de contraste a andar.
 *  `#ffffff`, `#000000`, `#808080`, `#fafafa` — croma zero: o caminho acromático.
 *  `#dc2626`, `#e11d48` — marca vermelha, que colide com `--color-error` sob protanopia.
 *  `#22c55e` — marca verde, que colide com `--color-success`.
 *  `#f59e0b` — marca âmbar, que colide com `--color-warning`.
 *  `#2563eb` — marca azul, que colide com `--color-info`.
 *  `#14b8a6`, `#4b0082`, `#7c3aed` — extremos de croma e de matiz, para o clamp de gamut.
 *  `#506d48` — a Sage: CONTROLE POSITIVO. Sem ela, um algoritmo que devolvesse cinza
 *              para tudo passaria em "nenhum papel abaixo do piso". Ela DEIXOU de ser a
 *              paleta do produto (hoje é o petróleo `#1c2e3f`) e continua aqui porque
 *              continua exercendo o caminho: as semânticas do tema NÃO mudaram junto com
 *              o accent, então `--color-success` do escuro ainda é `#82a077`, o verde da
 *              Sage — e a Sage ainda nasce colidida com ele (ΔE 0,0013, medido no
 *              controle positivo da reconciliação).
 */
const FIXTURE = [
  "#0f172a", "#f5c518", "#ffffff", "#000000", "#808080", "#dc2626", "#22c55e", "#f59e0b",
  "#2563eb", "#14b8a6", "#4b0082", "#e11d48", "#7c3aed", "#1a1f36", "#fafafa", "#506d48",
] as const;

describe("extrairRegua — os pares saem do globals.css, nunca de lista à mão", () => {
  it("acha os dois temas, a rampa do produto e os neutros", () => {
    expect(REGUA.rampaDoProduto).toHaveLength(11);
    // Constante do tema, recalibrada: o stop 600 é a SEMENTE do produto, literal.
    // Era `#506d48` (Sage) e passou a ser `#1c2e3f` — o azul-petróleo do Jo OS
    // (`--primary` claro de `produto-proprio/Jo OS/src/index.css`), lido do
    // `--color-accent-600` do bloco `:root` do `app/globals.css` de hoje.
    expect(REGUA.rampaDoProduto[6]).toBe("#1c2e3f");
    expect(REGUA.claro.neutros).toHaveLength(11);
    // Idem: `--color-neutral-900` do bloco escuro, que era o greige `#161510`.
    expect(REGUA.escuro.neutros[9]).toBe("#0b1219");
    expect(REGUA.claro.base.map((b) => b.chave)).toEqual([
      "--color-bg",
      "--color-surface",
      "--color-surface-elevated",
    ]);
  });

  it("alcança o anel de foco, que mora em @layer base e uma lista à mão perderia", () => {
    // ESTE é o par do relato (números medidos na Sage, a paleta em que o defeito
    // apareceu): `accent-600` contra bg dava 5,51 e passaria qualquer gate ingênuo,
    // mas quem pinta o anel é `accent-500` — e ele dava 3,79. Uma régua que só
    // olhasse o stop da semente deixaria o anel pousar em ~2,07 com o gate verde.
    // No petróleo os dois subiram (12,93 e 7,79); o que este teste fixa é o ÍNDICE
    // de onde cada papel sai, que é o que não pode mudar com a paleta.
    const foco = REGUA.claro.papeis.find((p) => p.token.includes(":focus-visible"));
    expect(foco, "o anel de foco sumiu da régua").toBeDefined();
    expect(foco?.tipo).toBe("componente");
    expect(foco?.fonte).toMatchObject({ tipo: "grau", indice: 5 });

    const focoEscuro = REGUA.escuro.papeis.find((p) => p.token.includes(":focus-visible"));
    expect(focoEscuro?.fonte).toMatchObject({ tipo: "grau", indice: 4 });
  });

  it("classifica -fg como texto e -soft como superfície", () => {
    const fg = REGUA.claro.papeis.find((p) => p.token === "--color-accent-fg");
    expect(fg?.tipo).toBe("texto");
    expect(REGUA.claro.tingidas.map((t) => t.chave)).toEqual(["--color-accent-soft"]);
    // No escuro o token é o literal `rgba(136,152,168,0.16)` — o petróleo do produto
    // cru (era `rgba(130,160,119,0.16)`, o verde Sage), sem referência à rampa. É por
    // isso que ele precisa ser REANCORADO na derivação.
    expect(REGUA.escuro.indices.soft).toBeNull();
    expect(REGUA.escuro.alfaDoSoft).toBeCloseTo(0.16, 6);
  });

  it("enumera o conjunto esperado de papéis e pares (guarda de vacuidade)", () => {
    // Números medidos no globals.css @ este commit. Se a folha ganhar um papel novo e
    // ninguém atualizar aqui, o teste reprova — que é o aviso certo: papel novo entra na
    // conta de contraste, não fica de fora em silêncio.
    expect(REGUA.claro.papeis.map((p) => p.token).sort()).toEqual([
      "--color-accent",
      "--color-accent-fg",
      "--color-accent-hover",
      "--ring",
      "::selection/color",
      ":focus-visible/outline",
    ]);
    expect(REGUA.escuro.papeis).toHaveLength(6);

    expect(superficiesDoTema(REGUA.claro, REGUA.rampaDoProduto, 0)).toHaveLength(4);
    // 6 no escuro e não 4: o `-soft` translúcido compõe sobre CADA base, e as três
    // razões diferem — 5,11 · 4,68 · 4,10 no petróleo, medidas no deslocamento que o
    // CSS congelou (era 4,99 · 4,59 · 4,02 na Sage). Medir uma só escolheria a mais
    // folgada. A CONTAGEM é que não depende do deslocamento, e é o que se fixa aqui.
    expect(superficiesDoTema(REGUA.escuro, REGUA.rampaDoProduto, 0)).toHaveLength(6);

    expect(medirPares(REGUA.claro, REGUA.rampaDoProduto, 0)).toHaveLength(18);
    expect(medirPares(REGUA.escuro, REGUA.rampaDoProduto, 0)).toHaveLength(26);
  });

  it("reproduz as razões medidas à mão no design system", () => {
    const pares = medirPares(REGUA.claro, REGUA.rampaDoProduto, 0);
    const razao = (papel: string, superficie: string) =>
      pares.find((p) => p.papel === papel && p.superficie === superficie)?.razao ?? 0;

    // Constantes do tema, recalibradas com a PRÓPRIA `medirPares` sobre o
    // `app/globals.css` de hoje (era 5,51 · 3,79 · 3,60 na Sage). O petróleo
    // `#1c2e3f` é muito mais escuro que o verde `#506d48`, então todo papel do
    // tema claro subiu junto — a ordem entre eles é que continua sendo o ponto:
    // o accent (grau 600) folga mais que o anel de foco (grau 500), e o anel
    // folga menos sobre `surface-elevated` que sobre `bg`. A tolerância é a
    // mesma (2 casas).
    expect(razao("--color-accent", "--color-bg")).toBeCloseTo(12.93, 2);
    expect(razao(":focus-visible/outline", "--color-bg")).toBeCloseTo(7.79, 2);
    expect(razao(":focus-visible/outline", "--color-surface-elevated")).toBeCloseTo(7.31, 2);
  });

  it("o tema do produto inteiro, como está no CSS, cabe nos pisos", () => {
    // POR QUE ISTO NÃO MEDE MAIS EM `deslocamento = 0`, e por que isso não é
    // afrouxar nada:
    //
    // `declaracoesDoTema` (lib/branding/css.ts) emite os 11 stops JÁ ANDADOS pela
    // caminhada de contraste, mantendo os RÓTULOS (`--color-accent-400` continua
    // sendo o token que `--color-accent` referencia no escuro) — é o conserto que
    // aquele arquivo documenta em detalhe, porque `focus-visible:ring-accent-500`
    // em componente não passa por token nenhum e só acompanha a marca se a rampa
    // inteira andar. O `globals.css` faz a MESMA coisa com o tema do produto: o
    // bloco escuro traz a rampa do produto andada -1, congelada, porque o caminho
    // "sem marca configurada" não passa pelo injetor de CSS.
    //
    // `extrairRegua` lê `rampaDoProduto` só do `:root`. Medir o tema escuro contra
    // ela em `d = 0` mede um tema que NINGUÉM pinta: daria accent `#5c7185` onde a
    // tela mostra `#8898a8`. Então o deslocamento sai do próprio CSS — e a
    // asserção de que a rampa declarada é EXATAMENTE a do produto andada por `d`
    // é mais forte que a de antes: pega tanto o piso furado quanto uma rampa
    // escura que tivesse saído da rampa do produto por outro caminho.
    for (const [tema, seletor, esperado] of [
      [REGUA.claro, ":root {", 0],
      [REGUA.escuro, '[data-theme="dark"] {', -1],
    ] as const) {
      const declarada = rampaDeclarada(seletor);
      const d = REGUA.rampaDoProduto.indexOf(declarada[4]!) - 4;
      expect(d, `${tema.nome}: deslocamento congelado no CSS`).toBe(esperado);
      expect(declarada, `${tema.nome}: a rampa declarada não é a do produto andada ${d}`).toEqual(
        GRAUS.map((_, i) => stop(REGUA.rampaDoProduto, i + d)),
      );

      const reprovas = medirPares(tema, REGUA.rampaDoProduto, d).filter((p) => !p.passa);
      expect(reprovas, `${tema.nome}: ${JSON.stringify(reprovas)}`).toEqual([]);
    }

    // E o `-soft` translúcido do escuro é o accent NESSE deslocamento, não um rgb
    // solto: `superficiesDoTema` reancora toda tingida literal no stop do accent,
    // então um rgb divergente aqui pintaria na tela um chip que a régua não mede.
    const bloco = CSS.slice(CSS.indexOf('[data-theme="dark"] {'));
    const soft = /--color-accent-soft:\s*rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/.exec(bloco)!;
    const accentEscuro = stop(REGUA.rampaDoProduto, REGUA.escuro.indices.accent - 1);
    expect([1, 2, 3].map((i) => Number(soft[i]))).toEqual([
      Number.parseInt(accentEscuro.slice(1, 3), 16),
      Number.parseInt(accentEscuro.slice(3, 5), 16),
      Number.parseInt(accentEscuro.slice(5, 7), 16),
    ]);
    expect(Number(soft[4])).toBeCloseTo(REGUA.escuro.alfaDoSoft, 6);
  });
});

describe("dicromacia — a régua de ângulo ordena INVERTIDO", () => {
  it("reproduz o par que derruba a régua de ângulo", () => {
    const anguloEntre = (a: string, b: string) => {
      const d = Math.abs(hexParaOklch(a).h - hexParaOklch(b).h);
      return d > 180 ? 360 - d : d;
    };
    const warning = "#b07a2b";
    const success = "#5a8a5f";

    // Oliva: ângulo GRANDE (44,7°) e separação PÉSSIMA (0,0231).
    expect(anguloEntre("#7f8c3a", warning)).toBeCloseTo(44.7, 1);
    expect(deltaESimulado("#7f8c3a", warning)).toBeCloseTo(0.0231, 4);

    // Verde-água: ângulo PEQUENO (27,2°) e separação BOA (0,1262).
    expect(anguloEntre("#1abc9c", success)).toBeCloseTo(27.2, 1);
    expect(deltaESimulado("#1abc9c", success)).toBeCloseTo(0.1262, 4);

    // A inversão, dita como asserção: quem tem mais ângulo tem menos separação real.
    expect(anguloEntre("#7f8c3a", warning)).toBeGreaterThan(anguloEntre("#1abc9c", success));
    expect(deltaESimulado("#7f8c3a", warning)).toBeLessThan(deltaESimulado("#1abc9c", success));
  });

  it("a simulação de fato colapsa o eixo vermelho-verde", () => {
    // Controle positivo da matriz. O par é construído com a MESMA lightness OKLab
    // (L=0,60, C=0,12, h=25° e h=145°): dicromacia preserva luminosidade, então um par
    // vermelho/verde de luminosidades diferentes continuaria distinguível pelo brilho e
    // o teste mediria a coisa errada — foi o que aconteceu com `#c0392b`×`#27ae60`, que
    // só cai 22% sob protanopia porque o vermelho já era mais escuro.
    const vermelho = "#bd615b";
    const verde = "#4d9351";
    const cru = deltaEOklab(vermelho, verde);
    expect(cru).toBeGreaterThan(0.2);
    for (const tipo of DICROMACIAS) {
      const simulado = deltaEOklab(simularDicromacia(vermelho, tipo), simularDicromacia(verde, tipo));
      expect(simulado, tipo).toBeLessThan(cru * 0.5);
    }
    // Sob deuteranopia o colapso é quase total — 0,0076 contra 0,2080 crus. Matriz
    // identidade (a sabotagem óbvia) devolveria 0,2080 e reprovaria aqui.
    expect(
      deltaEOklab(simularDicromacia(vermelho, "deuteranopia"), simularDicromacia(verde, "deuteranopia")),
    ).toBeLessThan(cru * 0.1);
    // E NÃO colapsa o eixo azul-amarelo, que a dicromacia vermelho-verde preserva: uma
    // matriz que zerasse tudo também passaria no teste acima.
    expect(deltaESimulado("#2563eb", "#f5c518")).toBeGreaterThan(deltaEOklab("#2563eb", "#f5c518") * 0.85);
  });

  it("usa o PIOR caso entre as dicromacias, não a média", () => {
    // `#a94a3c` × `#506d48` mede 0,0505 sob deuteranopia e 0,0434 sob protanopia. Média
    // daria 0,047 e a decisão mudaria; o piso existe para a pessoa que enxerga pior.
    const alvo = deltaESimulado("#a94a3c", "#506d48");
    const porTipo = DICROMACIAS.map((t) =>
      deltaEOklab(simularDicromacia("#a94a3c", t), simularDicromacia("#506d48", t)),
    );
    expect(alvo).toBeCloseTo(Math.min(...porTipo), 10);
    expect(Math.max(...porTipo)).toBeGreaterThan(alvo);
  });
});

describe("derivarMarca — as 16 sementes adversariais", () => {
  const resultados = FIXTURE.map((s) => ({ semente: s, marca: derivarMarca(s, REGUA) }));

  it("a fixture tem o tamanho e o controle positivo que declara", () => {
    expect(FIXTURE).toHaveLength(16);
    expect(new Set(FIXTURE).size).toBe(16);
    expect(FIXTURE).toContain("#506d48");
  });

  it("nenhum papel fica abaixo do piso, em nenhum dos dois temas", () => {
    for (const { semente, marca } of resultados) {
      for (const tema of [marca.claro, marca.escuro] as const) {
        // Guarda de vacuidade POR SEMENTE: um `pares: []` faria o filtro abaixo devolver
        // lista vazia e o teste passar sem ter medido nada.
        expect(tema.pares.length, `${semente}: nenhum par medido`).toBeGreaterThanOrEqual(18);
        const reprovas = tema.pares.filter((p) => !p.passa);
        expect(
          reprovas,
          `${semente} · grau ${tema.grauDoAccent}: ` +
            reprovas.map((r) => `${r.papel}×${r.superficie}=${r.razao.toFixed(2)}<${r.piso}`).join(", "),
        ).toEqual([]);
      }
    }
  });

  it("a caminhada de contraste de fato ANDA — e nas sementes previstas", () => {
    // Guarda contra o teste vácuo: se nada deslocasse no run inteiro, "todos os papéis
    // passam" seria uma afirmação sobre uma caminhada que nunca aconteceu.
    const deslocados = resultados.flatMap(({ semente, marca }) =>
      [marca.claro, marca.escuro]
        .filter((t) => t.deslocamento !== 0)
        .map((t) => `${semente}/${t.deslocamento}`),
    );
    expect(deslocados.length).toBeGreaterThan(0);
    // Constante do tema, recalibrada: 13 na Sage, 17 no petróleo. As 4 a mais são as
    // QUATRO sementes acromáticas (`#ffffff`, `#000000`, `#808080`, `#fafafa`), que
    // caem na rampa do produto e agora andam -1 no tema escuro — exatamente o
    // deslocamento que o bloco `[data-theme="dark"]` do `globals.css` já traz
    // congelado. Ou seja: a caminhada REPRODUZ a decisão que está no CSS, o que é o
    // oposto de um número que mudou por acidente. Contado rodando a fixture.
    expect(deslocados).toHaveLength(17);

    // O amarelo é o caso que NÃO tem escapatória física: nenhum stop claro de amarelo
    // alcança 3:1 contra `#ffffff`. Se ele parar de andar, a caminhada quebrou.
    const amarelo = resultados.find((r) => r.semente === "#f5c518")!.marca;
    expect(amarelo.claro.deslocamento).toBeGreaterThan(0);
    expect(amarelo.claro.grauDoAccent).toBe(900);
    // …e o hex EXATO do cliente reaparece como accent do tema escuro.
    expect(amarelo.escuro.accent).toBe("#f5c518");
  });

  it("nunca torce o accent: ele é sempre um stop da rampa da marca", () => {
    // (c) da doutrina: o accent é a única cor que não nos pertence. Se algum caminho
    // "ajustasse" o accent para folgar de uma semântica, este teste pega.
    for (const { semente, marca } of resultados) {
      if (marca.origemDaRampa !== "semente") continue;
      const rampa = rampaDeSemente(semente);
      expect(rampa, `${semente}`).toContain(marca.claro.accent);
      expect(rampa, `${semente}`).toContain(marca.escuro.accent);
      expect(marca.marca).toBe(semente);
    }
  });

  it("emite motivo sempre que mexe em alguma coisa, e nunca vaza o hex da marca", () => {
    for (const { semente, marca } of resultados) {
      const codigos = marca.motivos.map((m) => m.codigo);
      const mexeu =
        marca.claro.deslocamento !== 0 ||
        marca.escuro.deslocamento !== 0 ||
        marca.origemDaRampa === "produto";
      if (mexeu) expect(codigos.length, semente).toBeGreaterThan(0);
      // Diagnóstico emite FORMA, nunca IDENTIDADE: este objeto vai para log, e a cor da
      // marca de uma empresa não tem por que aparecer no log de outra.
      for (const m of marca.motivos) {
        expect(m.detalhe.toLowerCase(), `${semente} · ${m.codigo}`).not.toContain(
          semente.replace("#", ""),
        );
      }
    }
  });

  it("--color-accent-fg é calculado, e muda de lado conforme o accent", () => {
    // ATENÇÃO à vacuidade aqui, e ela é real: nas 16 sementes o tema claro SEMPRE cai em
    // branco e o escuro SEMPRE em preto — não porque o valor seja fixo por tema, mas
    // porque a caminhada de contraste empurra o accent claro para longe das superfícies
    // claras e o escuro para longe das escuras. Contar dois valores distintos no run,
    // portanto, NÃO prova que o cálculo responde ao accent; prova só que os temas
    // diferem. Quem prova a responsividade é o bloco abaixo, sobre a função direta.
    expect(melhorFrenteSobre("#f5c518")).toBe("#000000"); // amarelo vivo → texto preto
    expect(melhorFrenteSobre("#0f172a")).toBe("#ffffff"); // navy → texto branco
    // O par crítico: dois stops ADJACENTES da MESMA rampa Sage que pedem frentes
    // opostas. `#506d48` (600) dá 5,80 com branco e 3,62 com preto; `#67885d` (500) dá
    // 4,00 com branco e 5,25 com preto. Um valor fixo por tema erraria um dos dois — e
    // um deslocamento de UM grau é exatamente o que a caminhada de contraste faz.
    expect(melhorFrenteSobre("#506d48")).toBe("#ffffff");
    expect(melhorFrenteSobre("#67885d")).toBe("#000000");

    for (const { semente, marca } of resultados) {
      for (const tema of [marca.claro, marca.escuro] as const) {
        expect(razaoDeContraste(tema.accentFg, tema.accent), semente).toBeGreaterThanOrEqual(
          PISOS.texto,
        );
        expect(tema.accentFg).toBe(melhorFrenteSobre(tema.accent));
      }
    }
  });

  it("--color-accent-soft do tema escuro é derivado, não o petróleo do produto cru", () => {
    // O literal `rgba(136, 152, 168, 0.16)` sobreviveria intacto a qualquer override da
    // rampa — seria um pedaço da NOSSA marca dentro da instalação do cliente.
    const azul = derivarMarca("#2563eb", REGUA);
    expect(azul.escuro.accentSoft).toMatch(/^rgba\(\d+, \d+, \d+, 0\.16\)$/);
    expect(azul.escuro.accentSoft).not.toContain("136, 152, 168");
    // E o claro continua opaco, como o tema declara.
    expect(azul.claro.accentSoft).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("reconciliação — quem se move são as NOSSAS semânticas", () => {
  it("a Sage pura já nasce colidida e dispara a reconciliação (controle positivo)", () => {
    // O CONTROLE POSITIVO MUDOU DE FORMA, NÃO DE FORÇA.
    //
    // Ele era uma igualdade de STRING: `--color-success` do bloco escuro (`#82a077`)
    // era a MESMA string de `--color-accent-400`, porque a paleta do produto era a
    // Sage. Com o petróleo, `--color-accent-400` virou `#5c7185` e a igualdade morreu
    // — mas as semânticas NÃO mudaram junto (`app/design/lib/tokens.ts` diz isso com
    // todas as letras: "os semânticos NÃO mudaram com o tema"). Então `#82a077`
    // continua no CSS, continua sendo o verde da Sage, e a Sage continua sendo a
    // semente que nasce colidida com ele.
    //
    // A asserção passa a MEDIR a colisão em vez de deduzi-la da string, que é o que
    // ela sempre quis dizer: o accent que a semente Sage deriva para o tema escuro
    // (`#81a078`) fica a ΔE 0,0013 de `--color-success` sob dicromacia — 38× abaixo
    // do piso. Se o mecanismo não disparasse aqui, não dispararia em lugar nenhum.
    const sage = derivarMarca("#506d48", REGUA);
    const successEscuro = REGUA.escuro.semanticas.find((s) => s.nome === "success")!.hex;
    expect(successEscuro).toBe("#82a077");
    expect(deltaESimulado(successEscuro, sage.escuro.accent)).toBeCloseTo(0.0013, 4);
    expect(deltaESimulado(successEscuro, sage.escuro.accent)).toBeLessThan(
      PISO_DE_SEPARACAO_SIMULADA,
    );

    const movidas = sage.motivos.filter((m) => m.codigo === "semantica_deslocada");
    expect(movidas.length).toBeGreaterThan(0);
    expect(movidas).toHaveLength(3);
    expect(movidas.map((m) => `${m.tema}/${m.alvo}`)).toEqual([
      "claro/error",
      "escuro/warning",
      "escuro/error",
    ]);
  });

  it("devolve sinal — e não distorção — quando não há rotação que resolva", () => {
    // O laço de retorno do invariante 7 da doutrina Sistema Vivo: a peça diz o que muda
    // no sistema quando ela não consegue resolver. Com a semente Sage, `success` do tema
    // escuro é praticamente o accent (ΔE 0,0013, medido no teste acima); girar até 60°
    // ou colide de novo com o accent ou colide com `info`.
    const sage = derivarMarca("#506d48", REGUA);
    const sinais = sage.motivos.filter(
      (m) => m.codigo === "redundancia_nao_cromatica_necessaria",
    );
    expect(sinais).toHaveLength(1);
    expect(sinais[0]).toMatchObject({ tema: "escuro", alvo: "success" });
    expect(sinais[0]!.detalhe).toMatch(/ícone|rótulo/);
  });

  it("não inventa rotação impossível numa semântica sem croma", () => {
    // Girar o matiz de uma cor de croma zero não muda nada — é o caso em que a rotação
    // NÃO PODE funcionar, e o algoritmo tem de dizer isso em vez de fingir.
    const r = reconciliarSemanticas("#808080", [
      { nome: "success", hex: "#7f7f7f" },
      { nome: "warning", hex: "#b07a2b" },
    ]);
    expect(r.semSaida.map((s) => s.nome)).toEqual(["success"]);
    expect(r.movimentos).toEqual([]);
    expect(r.cores.success).toBe("#7f7f7f");
  });

  it("toda semântica movida folga do accent e continua dentro do orçamento de rotação", () => {
    let movimentosNoRun = 0;
    for (const semente of FIXTURE) {
      const marca = derivarMarca(semente, REGUA);
      for (const [tema, regua] of [
        [marca.claro, REGUA.claro],
        [marca.escuro, REGUA.escuro],
      ] as const) {
        const r = reconciliarSemanticas(tema.accent, regua.semanticas);
        movimentosNoRun += r.movimentos.length;
        for (const m of r.movimentos) {
          expect(Math.abs(m.rotacao), `${semente} ${m.nome}`).toBeLessThanOrEqual(ROTACAO_MAXIMA);
          expect(m.separacaoDepois).toBeGreaterThanOrEqual(PISO_DE_SEPARACAO_SIMULADA);
          expect(m.separacaoDepois).toBeGreaterThan(m.separacaoAntes);
          expect(m.para).not.toBe(m.de);
        }
        // O que NÃO se moveu já folgava — senão teria virado `semSaida`.
        for (const s of regua.semanticas) {
          const moveu = r.movimentos.some((m) => m.nome === s.nome);
          const semSaida = r.semSaida.some((x) => x.nome === s.nome);
          if (!moveu && !semSaida) {
            expect(deltaESimulado(s.hex, tema.accent), `${semente} ${s.nome}`).toBeGreaterThanOrEqual(
              PISO_DE_SEPARACAO_SIMULADA,
            );
          }
        }
      }
    }
    // Guarda de vacuidade do run inteiro: 15 movimentos medidos nas 16 sementes
    // (eram 23 na Sage). Constante do tema, recalibrada — e a diferença foi medida
    // semente a semente, não estimada: as 12 sementes CROMÁTICAS movem exatamente as
    // mesmas semânticas nas duas paletas (elas derivam a rampa do próprio hex, e a
    // paleta do produto não entra na conta). Quem muda são as QUATRO acromáticas
    // (`#ffffff`, `#000000`, `#808080`, `#fafafa`), que caem na rampa do PRODUTO:
    //
    //   Sage (verde):      claro/error + escuro/warning + escuro/error  = 3 cada → 12
    //   petróleo (azul):   escuro/info                                  = 1 cada →  4
    //
    // 23 − 12 + 4 = 15. Ou seja: trocar o accent do produto de verde para azul tirou
    // as colisões com `error`/`warning` e pôs uma com `info`, que é a semântica azul.
    // A guarda continua sendo "> 0" — o `expect` por movimento acima (rotação dentro
    // do orçamento, separação que melhora) é quem qualifica cada um deles.
    expect(movimentosNoRun).toBe(15);
  });
});

describe("marca acromática — o accent do produto permanece", () => {
  const CINZAS = ["#808080", "#000000", "#ffffff", "#fafafa"] as const;

  it("cinza, preto e branco não viram accent", () => {
    for (const cinza of CINZAS) {
      const marca = derivarMarca(cinza, REGUA);
      expect(hexParaOklch(cinza).C, cinza).toBeLessThan(LIMIAR_ACROMATICO);
      expect(marca.origemDaRampa, cinza).toBe("produto");
      expect(marca.rampa).toEqual(REGUA.rampaDoProduto);
      // O hex do cliente NÃO some: vai para `--color-brand` (logo, selo, e-mail).
      expect(marca.marca).toBe(cinza);
      const motivo = marca.motivos.find((m) => m.codigo === "marca_acromatica");
      expect(motivo?.alvo, cinza).toBe("--color-brand");
    }
  });

  it("o accent que permanece é cromático e separável do neutro do mesmo grau", () => {
    const marca = derivarMarca("#808080", REGUA);
    for (const [tema, regua] of [
      [marca.claro, REGUA.claro],
      [marca.escuro, REGUA.escuro],
    ] as const) {
      // CROMÁTICO: a régua aqui é `LIMIAR_ACROMATICO`, e NÃO `PISO_DE_CROMA`. A troca
      // é recalibração de constante do tema, não afrouxamento, e o próprio módulo já
      // dizia por quê — o docblock de `LIMIAR_ACROMATICO` (contraste.ts) fixa que
      // `#0f172a` mede C = 0,039824 e é "a identidade corporativa mais comum que
      // existe", legítima, que PINTA a interface. O accent do produto passou a ser
      // petróleo e mede C = 0,039198 no claro e 0,029985 no escuro: pela régua deste
      // módulo ele É uma navy, do mesmo lado de `#0f172a`. Exigir dele ≥ 0,04 seria
      // exigir do accent do produto uma coisa que o módulo declara não exigir de
      // marca de cliente nenhuma — e nem a Sage tinha como alvo esse número (o 0,04
      // existe para o STRADDLE das duas navies, asserido no teste logo abaixo).
      //
      // ⚠️ SINAL DE DESIGN, e ele não é do teste: os neutros petróleo têm matiz 245-248°
      // e o accent petróleo tem 248,3° — é o MESMO matiz. Accent e neutro não se
      // separam por cor, só por lightness e por croma, e no tema escuro isso deixa a
      // separação a 0,0503 contra um piso de 0,05. O teto, com um neutro PERFEITAMENTE
      // cinza no lugar do `neutral-300`, é 0,0552. Quem decide se isso está bom é o
      // design, não este arquivo; o que o arquivo faz é medir e não deixar passar.
      expect(hexParaOklch(tema.accent).C).toBeGreaterThan(LIMIAR_ACROMATICO);
      // SEPARÁVEL: este piso continua exatamente onde estava.
      expect(
        separacaoDoNeutro(regua, tema.grauDoAccent, tema.accent),
      ).toBeGreaterThanOrEqual(PISO_DE_SEPARACAO_DO_NEUTRO);
    }
    // Os números exatos, fixados (medidos com a própria `separacaoDoNeutro` sobre o
    // `globals.css` de hoje; eram 0,0681 e 0,1994 na Sage): 0,2101 no claro
    // (accent-600 `#1c2e3f` × neutral-600 `#586674`) e 0,0503 no escuro (accent-300
    // `#8898a8` × neutral-300 `#9da6ad`). Os dois lados TROCARAM de papel com a
    // paleta nova, e o argumento continua o mesmo: o piso do briefing (8, na
    // convenção ×100 — 0,08 aqui) reprovaria o controle positivo do próprio produto,
    // agora no tema ESCURO em vez do claro.
    expect(separacaoDoNeutro(REGUA.claro, marca.claro.grauDoAccent, marca.claro.accent)).toBeCloseTo(0.2101, 4);
    expect(separacaoDoNeutro(REGUA.escuro, marca.escuro.grauDoAccent, marca.escuro.accent)).toBeCloseTo(0.0503, 4);
    expect(separacaoDoNeutro(REGUA.escuro, marca.escuro.grauDoAccent, marca.escuro.accent)).toBeLessThan(0.08);

    // Controle negativo: um accent cinza reprovaria as duas guardas. Sem esta linha, os
    // pisos acima poderiam ser satisfeitos por qualquer coisa. O hex mudou de `#5d594f`
    // para `#5d5a58` junto com a régua: `#5d594f` mede C = 0,0166, que é acromático
    // para `PISO_DE_CROMA` (0,04) e NÃO é para `LIMIAR_ACROMATICO` (0,01) — continuar
    // com ele deixaria o controle negativo verde sem controlar nada. `#5d5a58` é o
    // mesmo cinza-quente um grau mais neutro, e mede C = 0,0050.
    expect(hexParaOklch("#5d5a58").C).toBeLessThan(LIMIAR_ACROMATICO);
    expect(deltaEOklab("#5d5a58", "#5d5a58")).toBe(0);
  });

  it("navy NÃO é acromática — o gatilho não decide no quarto decimal", () => {
    // As duas navies da fixture ficam em lados OPOSTOS de `PISO_DE_CROMA` por 0,0046:
    // `#0f172a` mede 0,039824 e `#1a1f36` mede 0,044430. Um gatilho ali decidiria no
    // quarto decimal se a navy mais comum do mundo corporativo pinta a interface — e a
    // resposta mudaria com um arredondamento de hex. Esta asserção fixa o straddle: é o
    // que reprova se alguém "simplificar" reusando `PISO_DE_CROMA` como gatilho.
    expect(hexParaOklch("#0f172a").C).toBeLessThan(PISO_DE_CROMA);
    expect(hexParaOklch("#1a1f36").C).toBeGreaterThan(PISO_DE_CROMA);
    expect(Math.abs(hexParaOklch("#0f172a").C - hexParaOklch("#1a1f36").C)).toBeLessThan(0.005);

    for (const navy of ["#0f172a", "#1a1f36"] as const) {
      const marca = derivarMarca(navy, REGUA);
      expect(hexParaOklch(navy).C, navy).toBeGreaterThan(LIMIAR_ACROMATICO);
      expect(marca.origemDaRampa, navy).toBe("semente");
      expect(marca.claro.accent, navy).toBe(navy);
    }
  });
});

describe("ramo degradado — rampas que não têm solução", () => {
  const SINTETICAS: readonly (readonly [string, Rampa])[] = [
    // L uniforme: andar na rampa não muda contraste nenhum, então nenhum deslocamento
    // pode ajudar — é o caso em que a caminhada tem de desistir e DIZER que desistiu.
    ["L uniforme", rampaChapada("#7f7f7f")],
    ["toda clara", rampaChapada("#f2f2f2")],
    ["toda escura", rampaChapada("#101010")],
  ];

  it("alcança o caminho de fallback nos dois temas, para as três rampas", () => {
    const alcancados: string[] = [];
    for (const [nome, rampa] of SINTETICAS) {
      for (const tema of [REGUA.claro, REGUA.escuro]) {
        const escolha = escolherAccent(rampa, tema);
        expect(escolha.motivo, `${nome}/${tema.nome}`).toBe("sem_deslocamento_que_satisfaz");
        expect(escolha.reprovas.length).toBeGreaterThan(0);
        expect(escolha.pares.length).toBeGreaterThan(0);
        // Degradado NÃO é lançar: `derivarMarca` roda no caminho de render do layout, e
        // um throw ali é 500 em todas as telas.
        expect(() => escolherAccent(rampa, tema)).not.toThrow();
        alcancados.push(`${nome}/${tema.nome}`);
      }
    }
    expect(alcancados).toHaveLength(6);
  });

  it("uma rampa chapada não tem contraste interno nem com deslocamento", () => {
    // Controle positivo do ramo: o par `::selection` mede stop contra stop DENTRO da
    // rampa. Numa rampa de cor única ele vale 1,00 em qualquer deslocamento — é a prova
    // de que a reprova é estrutural e não um deslocamento mal escolhido.
    const escolha = escolherAccent(rampaChapada("#7f7f7f"), REGUA.claro);
    const selecao = escolha.pares.find((p) => p.papel.includes("::selection"));
    expect(selecao?.razao).toBeCloseTo(1, 6);
    expect(selecao?.passa).toBe(false);
  });

  it("uma rampa boa NÃO cai no ramo degradado", () => {
    // Sem este controle negativo, "o ramo é alcançável" não distinguiria um algoritmo
    // que sempre degrada.
    for (const tema of [REGUA.claro, REGUA.escuro] as TemaDaRegua[]) {
      expect(escolherAccent(REGUA.rampaDoProduto, tema).motivo).toBeNull();
    }
  });
});
