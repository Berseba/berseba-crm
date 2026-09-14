# 00 — Overview

> **Source of truth:** `app/globals.css` + `app/layout.tsx` (o que o produto pinta e carrega), espelhados em `app/design/lib/tokens.ts` e descritos por esta pasta. Showcase em `app/design/README.md`.

## Filosofia

O DeskcommCRM é uma ferramenta operacional para **atendentes que ficam 8 horas por dia em frente à tela**. Toda decisão visual passa por esse filtro: o que reduz fadiga, o que acelera leitura, o que sustenta foco.

Por isso a direção é **soft-tech / calmo**:

- **Soft** — neutros desaturados e tingidos de um matiz só (petróleo, ~210°, desde o tema Marca Jo; greige na v1.0), nunca slate/zinc de catálogo; acentos baixos em saturação; sombras tingidas com a cor do texto, não preto puro.
- **Tech** — tipografia precisa, dados em mono tabular, hierarquia disciplinada, microinterações com propósito.
- **Calmo** — sem decoração, sem celebração, sem AI-sparkle, sem gradientes. Confiança vem de consistência, não de efeito.

A meta secundária é **não parecer genérico**. 80% dos CRMs SaaS atuais convergem para o mesmo molde (Inter + Lucide + slate + accent indigo + glassmorphism). DeskcommCRM diverge intencionalmente em todas essas escolhas.

## Princípios canônicos

Quando duas decisões parecem igualmente boas, esta lista é a tiebreaker:

1. **Clarity > decoration.** Se um elemento não comunica, ele sai. Sombras decorativas, gradients, ícones que repetem o label — fora.
2. **Calm > vibrant.** Saturação alta cansa; contraste calibrado é mais legível que contraste máximo. Nenhum accent passa de stop 600 em áreas grandes.
3. **Consistency > novelty.** Uma escolha boa repetida 100 vezes é melhor que 100 escolhas únicas. Componentes têm variants finitos e nomeados.
4. **Accessibility > aesthetic.** WCAG AA é piso, não teto — e é medido, não presumido (`tests/unit/branding-contraste.test.ts` roda a régua sobre cada par pintado). Focus rings sempre 2px visíveis.
5. **Intentional density.** Aerada é default; densidade só comprime quando o conteúdo justifica (tabela de dados). Whitespace não é desperdício, é respiração.

## Estrutura da documentação

Os 11 arquivos desta pasta dividem o sistema em camadas:

- **00–01** — fundação (filosofia + tokens primitivos).
- **02–05** — primitivos visuais (cor, tipo, densidade, ícone).
- **06** — composição (componentes).
- **07–08** — comportamento (motion, voz).
- **09** — guard-rails (anti-patterns).

Leia 00 → 09 sequencial uma vez. Depois consulte por demanda via tabela do `README.md`.

## Versionamento

- **v1.0 — locked em 2026-04-28 (upstream DeskcommCRM).** As 5 escolhas eram Sage, Atkinson Hyperlegible, Aerada, Phosphor, IBM Plex Mono. Fica registrada como histórico: a paleta Sage e o par Atkinson continuam no showcase (`PALETTES.sage`, `TYPOS.atkinson`) só para comparação.
- **Tema "Marca Jo" — este fork, a partir de 2026-09-13.** O produto passa a nascer com a linguagem visual do Jo OS (o sistema interno da Jordão Aceleração IA). O que mudou e o que não mudou:
  - **Mantido:** os princípios acima (calmo, sem gradiente, sem AI-sparkle, sem decoração), a densidade Aerada, a iconografia, a linguagem de motion, a voz e o tom, os nomes de todos os tokens (`--color-bg`, `--radius-lg`, `--shadow-md`…) e os semânticos (`success`/`warning`/`error`/`info` são os mesmos hexes).
  - **Trocado:** a paleta — accent semente `#1c2e3f` (azul-petróleo) no claro e `#8898a8` sobre `#0b1219` no escuro, neutros tingidos do mesmo matiz (`02-palette-marca-jo.md`); a tipografia — Urbanist em títulos e Epilogue no corpo, IBM Plex Mono segue para dados (`03-typography.md`); os raios — 6/10/14/18 px em vez de 4/8/12/16 (`01-foundation-tokens.md`); e a tinta das sombras — `rgba(22, 36, 49, …)` em vez de `rgba(20, 18, 14, …)`.
  - **Como foi feito:** os valores vivem em `app/globals.css` e `app/layout.tsx` (commits "Tema padrão do produto passa a ser o do Jo OS" e "Accent padrão do produto vira o azul-petroleo do Jo OS"); a rampa do accent foi gerada por `rampaDeSemente` (`lib/branding/rampa.ts`), o mesmo algoritmo do white-label. Esta pasta e `app/design/lib/tokens.ts` foram sincronizadas em seguida.
  - **O que continua aberto:** o accent é o *piso* do white-label — instalação e organização seguem podendo trocá-lo em Configurações › Marca, exatamente como antes.
- Patches são aceitos para: novos ícones, novos exemplos de microcopy, ajustes de hex em ±2 pontos de luminosidade quando WCAG falhar, novos componentes derivados. Ajuste de hex entra **primeiro** no `app/globals.css` (e regenera `lib/branding/regua-do-produto.ts` pelo teste), depois é transcrito aqui.
- PRs que tentem trocar uma das escolhas de fundação (paleta, tipografia, densidade, iconografia) precisam de RFC — o tema Marca Jo foi a única exceção, por ser a identidade do dono do fork.
- Histórico de mudanças vai em `CHANGELOG.md` quando houver segunda mudança; a primeira está registrada aqui.

## Referências

A linguagem do DeskcommCRM toma emprestado partes específicas (não estética inteira) de quatro produtos:

- **Arc browser** — sidebar como "casa", microinterações de hover com propósito espacial, paleta neutra com 1 accent destacado.
- **Notion** — densidade aerada (row 56 / gap 24), tipografia humanista grande, hierarquia por peso e tamanho mais que por cor.
- **Things 3** — calma absoluta, ausência de ornamento, ícones com peso próprio, mono para dados (datas, contadores).
- **Mercury (banking)** — confiança operacional via consistência, paleta neutra de um matiz só, números em tabular nums, tom de voz sóbrio em microcopy.
- **Jo OS** (desde o tema Marca Jo) — a paleta petróleo e o par Urbanist/Epilogue vêm dele, para que o CRM e o sistema interno da Jordão sejam reconhecidos como a mesma casa.

O que **não** importamos: o Geist sans da Vercel/Linear (saturação de mercado), o roxo Linear (overuse), o glass do Mercury (mais tarefa que valor), os gradientes do Arc.
