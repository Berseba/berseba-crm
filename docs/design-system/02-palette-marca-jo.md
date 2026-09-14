# 02 — Paleta Marca Jo (azul-petróleo)

> **Source of truth:** `app/globals.css` (blocos `:root` e `[data-theme="dark"]`), espelhado em `app/design/lib/tokens.ts` → `PALETTES.jo` e congelado para o runtime em `lib/branding/regua-do-produto.ts` (gerado — não editar à mão).
>
> **Histórico:** até 2026-09-13 este arquivo se chamava `02-palette-sage.md` e descrevia a paleta Sage (verde-erva + neutros greige) da v1.0 upstream. Ela continua em `PALETTES.sage` no showcase, só para comparação; nenhuma tela do produto a pinta mais. Ver `00-overview.md` § Versionamento.

## Filosofia da paleta

A paleta é a do **Jo OS**, o sistema interno da Jordão Aceleração IA: um azul-petróleo escuro como semente (`#1c2e3f` = `hsl(209 38% 18%)`) e uma rampa de neutros tingida do mesmo matiz (~210°). O que ela projeta:

- **Sobriedade sem frieza corporativa** — o accent é escuro e pouco saturado (38% no 600, 16% no stop que o escuro usa); nada de azul-bandeira, indigo ou ciano.
- **Um matiz só** — neutros, superfícies, bordas e sombras carregam o mesmo ~210° do accent. A tela é monocromática no fundo e a cor só aparece onde há ação ou estado.
- **Funcional em monitores 8h/dia** — fundo nunca puro `#fff` (`#f5f7f9`) nem puro `#000` (`#0b1219`); contraste calibrado, não máximo.
- **Calmo, sem gradiente, sem AI-sparkle** — os princípios da v1.0 (`00-overview.md`) não mudaram; só as escolhas de cor.

A paleta tem **dois temas desenhados independentemente**, não invertidos. O escuro não é o claro com a luminosidade trocada: cada bloco do CSS foi calibrado na sua direção.

**A cor de marca é substituível.** O accent abaixo é o *piso* — vale quando nenhuma instalação nem organização configurou cor em Configurações › Marca. Quando alguém configura, `lib/branding/rampa.ts` deriva os 11 stops do hex colado com o **mesmo algoritmo** que gerou a rampa abaixo (`rampaDeSemente("#1c2e3f")` reproduz os 11 hexes byte a byte), e `lib/branding/contraste.ts` escolhe os papéis. Neutros, superfícies e semânticos **não** mudam com a marca.

## Light theme — accent (petróleo)

| Stop | Hex | Uso prescrito |
|------|-----|---------------|
| 50 | `#f3f5f8` | Background de hover muito sutil |
| 100 | `#dee4e9` | `--color-accent-soft` — bg de badge accent, hover de nav-link, active de sidebar |
| 200 | `#b8c3cd` | `::selection` bg; borders de elementos accent secundários |
| 300 | `#8898a8` | Disabled state do accent, decorative dividers |
| 400 | `#5c7185` | Hover de elementos accent claros |
| 500 | `#3a5064` | `--ring` e `:focus-visible` outline |
| 600 | `#1c2e3f` | **`--color-accent` — brand accent canônico (a semente, literal)** — botão primary bg, link |
| 700 | `#1c2937` | `--color-accent-hover` — hover/pressed de primary button |
| 800 | `#1b2631` | Texto sobre fundos accent claros |
| 900 | `#1b242c` | — (raramente usado em light) |
| 950 | `#181d22` | `::selection` color |

> Na rampa petróleo os stops 700–950 são quase indistinguíveis do 600 (a semente já é muito escura; a curva de croma cai nas pontas). É esperado — não "corrija" clareando: o hover do botão primário é sutil de propósito.

## Light theme — neutral petróleo

| Stop | Hex | Uso prescrito |
|------|-----|---------------|
| 50 | `#f5f7f9` | `--color-bg` — page background |
| 100 | `#ecf0f3` | Background de seções, alt-row de tabela |
| 200 | `#dae0e7` | `--color-border` — borders default |
| 300 | `#c2ccd6` | Borders mais firmes, divider de tabela (`--color-border-strong` é `#bcc7d2`) |
| 400 | `#97a6b4` | Placeholder text, ícone disabled |
| 500 | `#6e8091` | Texto utilitário (timestamp, helper) |
| 600 | `#586674` | `--color-text-muted` — texto secundário, label |
| 700 | `#394756` | Texto importante mas não primary |
| 800 | `#263340` | Heading secundário |
| 900 | `#162431` | `--color-text` — texto primary (corpo, headings) |
| 950 | `#0c141d` | Texto extremamente alto contraste (raro) |

**Surfaces light:**
- `bg`: `#f5f7f9` — página
- `surface`: `#ffffff` — cards e superfícies elevadas (puro branco)
- `surfaceElevated`: `#edf0f3` — alt-bg, header, dropdown bg
- `text`: `#162431` / `textMuted`: `#586674` / `textSubtle`: `#7c8c9c` / `border`: `#dae0e7` / `borderStrong`: `#bcc7d2`
- `overlay`: `rgba(21, 36, 50, 0.42)`

## Dark theme — accent (mesma semente, rampa andada −1 grau)

| Stop | Hex | Uso prescrito |
|------|-----|---------------|
| 50 | `#f3f5f8` | `::selection` color |
| 100 | `#f3f5f8` | — (colapsa com o 50: é o clamp da caminhada) |
| 200 | `#dee4e9` | — |
| 300 | `#b8c3cd` | `--color-accent-hover` — hover de link e de primary |
| 400 | `#8898a8` | **`--color-accent` em dark** — primary button bg, link, `--ring`, focus |
| 500 | `#5c7185` | Versão "calma" do accent em dark |
| 600 | `#3a5064` | Hover ainda mais escuro (raro) |
| 700 | `#1c2e3f` | `::selection` bg; border accent em dark |
| 800 | `#1c2937` | — |
| 900 | `#1b2631` | — |
| 950 | `#1b242c` | Background quase invisível (decorativo) |

> **Por que os stops do escuro não são os do claro:** `escolherAccent` (`lib/branding/contraste.ts`) mede que o stop 400 cru da rampa (`#5c7185`) não fecha o piso de contraste 1.4.11 (3:1) num dos papéis do tema escuro, e uma caminhada de −1 grau resolve todos. O CSS congela o resultado; o comentário no bloco `[data-theme="dark"]` de `app/globals.css` conta a medição. Os *rótulos* (`--color-accent` = 400, hover = 300, ring = 400) são os mesmos de sempre — o que mudou é o hex que mora em cada um.

`--color-accent-fg` em dark é `#0b1219` (o próprio `bg`); `--color-accent-soft` é `rgba(136, 152, 168, 0.16)` — o stop 400 a 16% sobre o fundo, não um stop sólido.

## Dark theme — neutral petróleo

| Stop | Hex | Uso prescrito |
|------|-----|---------------|
| 50 | `#edf0f3` | `--color-text` — texto primary em dark |
| 100 | `#dce0e5` | Texto sobre surface escuro (alta hierarquia) |
| 200 | `#b5bdc5` | Texto importante em dark |
| 300 | `#9ba6b0` | `--color-text-muted` — texto secundário |
| 400 | `#657381` | `--color-text-subtle` — placeholder, helper |
| 500 | `#3d4d5c` | Disabled |
| 600 | `#212e3b` | `--color-border` — borders default (`--color-border-strong` é `#304255`) |
| 700 | `#1a242e` | `--color-surface-elevated` — header, dropdown |
| 800 | `#101a23` | `--color-surface` — cards |
| 900 | `#0b1219` | `--color-bg` — page background |
| 950 | `#060a0e` | Voids decorativos (raro) |

**Surfaces dark:**
- `bg`: `#0b1219` — página (NÃO `#000` nem `#0a0a0a`; petróleo quase-preto)
- `surface`: `#101a23` — cards
- `surfaceElevated`: `#1a242e` — header, dropdown
- `text`: `#edf0f3` / `textMuted`: `#9ba6b0` / `textSubtle`: `#657381` / `border`: `#212e3b` / `borderStrong`: `#304255`
- `overlay`: `rgba(6, 10, 15, 0.55)`

## Estados (success / warning / error / info)

**Os semânticos não mudaram com o tema** — são os mesmos hexes da v1.0, porque já eram calmos e neutros em matiz. Saturação ≤ 55% em light, ≤ 65% em dark.

| Estado | Light | Light `-fg` | Dark | Dark `-fg` | Uso |
|--------|-------|-------------|------|------------|-----|
| `success` | `#5a8a5f` | `#41673f` | `#82a077` | `#a4ba9a` | Confirmação positiva, status "ativo", "lido" |
| `warning` | `#b07a2b` | `#875a1a` | `#d09455` | `#e0ad77` | Atenção sem urgência, SLA próximo de vencer |
| `error` | `#a94a3c` | `#8a3a2e` | `#c87263` | `#d99182` | Erro, ação destrutiva, SLA estourado |
| `info` | `#4a7a93` | `#355d72` | `#7da9bf` | `#9bbfd2` | Mensagem informativa, dica |

Cada estado tem `--color-<estado>-bg` no CSS: o próprio hex a 12% (light) ou 18% (dark) de alfa.

**Como aplicar estados (3 padrões):**

```css
/* 1. Como bg de badge: o token -bg (já é o estado a 12%/18%) + o -fg como texto */
.badge-success {
  background: var(--color-success-bg);
  color: var(--color-success-fg);
}

/* 2. Como border (foco específico): full opacity */
.input-error { border-color: var(--color-error); }

/* 3. Como bg de botão destrutivo: full opacity, fg branco */
.btn-destructive { background: var(--color-error); color: #fff; }
```

## Contraste WCAG

Razões calculadas (luminância relativa WCAG 2.x) sobre os hexes acima. A régua executável é `tests/unit/branding-contraste.test.ts`, que mede os pares pintados a cada run — este quadro é a leitura humana dela, não a fonte.

| Combinação | Ratio | Nível | OK pra |
|------------|-------|-------|--------|
| `text` (`#162431`) sobre `bg` (`#f5f7f9`) | 14.7:1 | AAA | Prosa longa, body text |
| `text-muted` (`#586674`) sobre `bg` | 5.5:1 | AA | Secondary, helper, timestamps |
| `text-subtle` (`#7c8c9c`) sobre `bg` | 3.2:1 | AA UI | Só placeholder e ícone; **não** para texto lido |
| `accent-600` (`#1c2e3f`) sobre `bg` | 12.9:1 | AAA | Link, texto UI, botão primary |
| `accent-fg` (`#ffffff`) sobre `accent-600` | 13.9:1 | AAA | Label do botão primary |
| `accent-500` (`#3a5064`, ring) sobre `bg` | 7.8:1 | AAA | Focus ring |
| `accent-700` (`#1c2937`) sobre `accent-soft` (`#dee4e9`) | 11.5:1 | AAA | Link em chip, label sobre badge |
| `error` light (`#a94a3c`) sobre `bg` | 5.2:1 | AA | UI text 14px+ |
| `info` light (`#4a7a93`) sobre `bg` | 4.4:1 | AA UI | Ícone, border; texto só com o `-fg` |
| `success` / `warning` light sobre `bg` | 3.7:1 / 3.5:1 | AA UI | Ícone, border, badge **com** `-fg` como texto — nunca o hex cru como texto |
| Dark: `text` (`#edf0f3`) sobre `bg` (`#0b1219`) | 16.5:1 | AAA | Body text |
| Dark: `text-muted` (`#9ba6b0`) sobre `bg` | 7.6:1 | AAA | Secondary |
| Dark: `accent-400` (`#8898a8`) sobre `bg` | 6.4:1 | AA+ | Link, primary |
| Dark: `accent-fg` (`#0b1219`) sobre `accent-400` | 6.4:1 | AA+ | Label do botão primary |
| Dark: `accent-300` (`#b8c3cd`, hover) sobre `bg` | 10.5:1 | AAA | Hover de link |
| Dark: `error` (`#c87263`) sobre `bg` | 5.4:1 | AA | UI text 14px+ |

**Regras:**
- Body text e prosa: AAA mínimo (`text` + `bg`).
- UI text 14px+: AA mínimo (4.5:1). `success`, `warning` e `info` crus **não** passam como texto sobre `bg` — use o `-fg` correspondente (é para isso que ele existe).
- Componentes não-textuais (borders, ícones): AA UI mínimo (3:1).
- Nunca usar `text-muted` nem `text-subtle` para texto em prosa longa (apenas labels, helpers, timestamps).

## Anti-padrões — como NÃO usar a paleta

❌ **Accent como bg de área grande.** O 600 é quase preto: um painel inteiro nele vira um buraco na tela. Accent é para botão primary, link, estado ativo — e só.

❌ **Accent como bg de toda a sidebar.** Sidebar é neutra (`surface` ou `surface-elevated`). Accent na sidebar fica como hover-state (`accent-soft`) e active-state apenas.

❌ **Accent em texto de longa leitura.** Body de e-mail, descrição de pedido, prosa de doc — tudo `text` (`#162431`). Accent só em link, label de status, ações.

❌ **`#000` ou `#fff` puro como página.** Use `#162431` sobre `#f5f7f9`; `surface` (cards) sim usa `#ffffff`.

❌ **Cores fora dos estados.** Não importe roxo, verde-limão, ciano — não fazem parte do sistema. Se precisa diferenciar tags do usuário, use stops do neutro + 1 acento. A única exceção declarada são as 8 trilhas de pessoa da agenda (`--agenda-pessoa-N` em `app/globals.css`), derivadas e medidas em OKLab — e mesmo elas carregam a inicial da pessoa junto, porque cor nunca é a única informação.

❌ **Gradients accent → accent.** A paleta não usa gradients; profundidade vem de border + shadow.

❌ **Fixar a rampa em componente.** `bg-[#1c2e3f]` quebra o white-label: o revendedor troca a cor e o seu componente continua petróleo. Sempre `bg-accent`, `text-accent`, `ring-accent-500`.

## Acessibilidade (visão de cor)

- **Deuteranopia / protanopia:** o accent é azul, o eixo que essas duas deficiências preservam — permanece distinguível dos estados `success` (verde) e `error` (vermelho), que por sua vez continuam separados entre si porque `error` é warm-red e `success` é verde-acinzentado.
- **Tritanopia (azul-amarelo, raro):** o accent perde matiz e vira cinza-escuro; como ele já é quase neutro, a hierarquia sobrevive por luminosidade. `info` (`#4a7a93`) fica próximo do accent — não use os dois lado a lado como única distinção.

Em todos os casos, **nunca dependa só de cor pra comunicar estado**. Use ícone + cor + label de texto. Ex: badge de SLA estourado tem cor error, ícone `Warning`, e texto "Vencido há 2h".
