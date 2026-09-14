# `/design` — Design System Showcase

> **Nota sobre o nome da pasta:** o briefing pediu `app/_design/`, mas Next.js
> trata folders prefixados com `_` como privados (não geram rota). Para que a
> URL `/design` seja navegável, a pasta foi nomeada `app/design/` (sem
> underscore). Se preferir o prefixo, renomeia e adicione um redirect
> em `next.config.ts`.

Painel navegável e isolado para iterar a direção visual do DeskcommCRM antes de
aplicar ao app real. Não toca em `app/layout.tsx` global; tem o seu próprio
`layout.tsx` com `<VariantProvider>` e CSS escopado em `showcase.css`.

## Como rodar

```bash
pnpm dev
# acesse http://127.0.0.1:3000/design  (ou :3001 se a 3000 estiver ocupada)
```

A rota é pública (sem auth) e tem `robots: noindex`.

## Como ler

1. **Sidebar** — navegação entre 8 seções: Tokens, Paletas, Tipografia,
   Densidade, Componentes, Padrões, Motion, Iconografia.
2. **Top bar** — switcher para trocar **paleta + tipografia + densidade + tema**
   em runtime via CSS Custom Properties. Tudo persiste em
   `localStorage` sob a key `deskcomm.designshowcase.v1`.
3. **Canvas central** — seção ativa, com botões "Aplicar X" embutidos em cada
   variante para trocar diretamente do conteúdo (não só do switcher).

## Direção visual

> Soft-tech / calmo — neutros desaturados de um matiz só (**não** slate/zinc de
> catálogo), 1 accent escuro e pouco saturado, sem gradiente, motion fluido,
> whitespace generoso, hierarquia tipográfica > decoração.

### Paletas (6)
`Marca Jo` (o produto) · `Sage` (v1.0 upstream) · `Clay` · `Mist` · `Plum` ·
`Olive` — cada uma com 11 stops do accent, 11 stops de neutro, 4 estados
(success/warning/error/info), versões **light e dark definidas separadamente**
(não invertidas).

`Marca Jo` é a única que pinta telas reais: todo hex dela foi lido de
`app/globals.css`, e o accent é `rampaDeSemente("#1c2e3f")`
(`lib/branding/rampa.ts`). Ela é também a única com `accentDark` (a rampa
andada −1 grau, como o CSS faz no `[data-theme="dark"]`). As outras cinco são
as candidatas avaliadas na v1.0 e ficam aqui para comparação lado a lado.

### Pareamentos tipográficos (5)
1. Urbanist + Epilogue (o produto — o mesmo par do Jo OS; default)
2. Bricolage Grotesque + Plus Jakarta Sans
3. Fraunces + Manrope
4. Atkinson Hyperlegible (v1.0 upstream; mono-stack a11y-first)
5. Source Serif 4 + IBM Plex Sans

O par 1 lê `--font-urbanist` / `--font-epilogue` / `--font-mono` do root layout
(`app/layout.tsx`), que envolve o showcase; os outros quatro são carregados por
`lib/fonts.ts`. Inter / Geist / Space Grotesk **proibidos** por saturação em
training data.

### Densidades (3)
- `Aerada` · row 56 / gap 24 (Notion-like)
- `Equilibrada` · row 44 / gap 16 (Things-like, default)
- `Compacta` · row 32 / gap 8 (Linear-like)

## Arquitetura

- `lib/tokens.ts` — o que o showcase renderiza: cores, fontes, densidade,
  motion. Para a paleta `jo`, raios e sombras ele é **espelho** de
  `app/globals.css` (a fonte de verdade do produto), não a origem — mudou o
  CSS, atualize aqui. `DEFAULT_PALETTE` / `DEFAULT_TYPO` dizem o que abre sem
  escolha salva.
- `lib/fonts.ts` — as fontes das paletas candidatas, via `next/font/google` no
  boot do `layout.tsx` (escopo isolado). O par do produto não está aqui: vem do
  root layout.
- `lib/variant-context.tsx` — Context React + `setProperty` em `:root` para
  injetar tokens. Hidrata de `localStorage`.
- `showcase.css` — todos os estilos do showcase prefixados `.ds-*`. Não interfere
  no resto do app.
- `sections/Section*.tsx` — uma por aba.
- `components/Switcher.tsx` — controle topo direito.

## Decisões notáveis

- **Default**: `Marca Jo + Urbanist/Epilogue + Equilibrada + Light` — o que o
  produto pinta desde o tema Marca Jo (2026-09-13). Até então era
  `Sage + Bricolage/Jakarta`: Sage projetava calma operacional sem cair em
  "saúde mental clichê"; Bricolage tinha width axis útil para headers de inbox.
  Quem já tinha escolha salva em `localStorage` continua vendo a dela.
- **Iconografia recomendada**: Phosphor (duotone). Justificativa na seção Iconografia.
- **CSS variables, não Tailwind classes**: o showcase intencionalmente fica fora
  do tema do app para não poluí-lo antes da decisão final. Quando a variante for
  escolhida, migra-se para o `@theme inline` de `app/globals.css` com
  `var(--accent-N)` e os tokens viram parte do build. (Até o Tailwind 4 o alvo
  era `theme.extend.colors` do `tailwind.config.ts`, que não existe mais.)
