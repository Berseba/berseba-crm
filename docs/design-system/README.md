# Design System DeskcommCRM — Documentação Canônica

> **Versão:** v1.0 (lockada em 2026-04-28) + tema **Marca Jo** (este fork, desde 2026-09-13)
> **Status:** Ativa
> **Direção:** Soft-tech / calmo, anti-genérico
> **Stack visual:** Petróleo (Jo OS) + Urbanist (títulos) / Epilogue (corpo) + IBM Plex Mono + Aerada + Phosphor (duotone)

Esta pasta é a **fonte canônica** da linguagem visual do DeskcommCRM. Toda decisão de UI deve consultar estes documentos antes de implementação. Quando houver conflito entre código e doc, **a doc vence** — ajuste o código.

Exceção única, e declarada: os **valores** de cor, raio e sombra têm como fonte executável o `app/globals.css` — a doc os transcreve, e `lib/branding/regua-do-produto.ts` (gerado) os congela para o runtime. Se um hex daqui divergir do CSS, quem está errado é este texto; corrija a transcrição, não o CSS.

## Índice

| # | Documento | O que cobre |
|---|-----------|-------------|
| 00 | [Overview](./00-overview.md) | Filosofia, princípios, referências, versionamento |
| 01 | [Foundation Tokens](./01-foundation-tokens.md) | Spacing, radius, shadow, motion, z-index |
| 02 | [Paleta Marca Jo](./02-palette-marca-jo.md) | 22 stops com hex (light + dark), estados, contraste |
| 03 | [Tipografia](./03-typography.md) | Urbanist + Epilogue, escala, IBM Plex Mono |
| 04 | [Densidade Aerada](./04-density-aerada.md) | Row 56 / gap 24, quando overrider |
| 05 | [Iconografia Phosphor](./05-iconography-phosphor.md) | Duotone, mapeamento por feature |
| 06 | [Componentes](./06-components.md) | shadcn customizado + componentes do produto |
| 07 | [Motion Language](./07-motion-language.md) | 4 tipos canônicos, curvas, durations |
| 08 | [Voz e Tom](./08-voice-and-tone.md) | PT-BR profissional calmo, microcopy |
| 09 | [Anti-patterns](./09-anti-patterns.md) | O que não fazer, com alternativas |

## Mapa decisão → source of truth

| Decisão | Onde está canonizada | Quando consultar |
|---------|----------------------|------------------|
| Cor (hex, stop, estado) | `app/globals.css` → transcrito em `02-palette-marca-jo.md` e `app/design/lib/tokens.ts` (`PALETTES.jo`) | Sempre que precisar referenciar uma cor |
| Spacing / radius / shadow | `app/globals.css` → transcrito em `01-foundation-tokens.md` e `app/design/lib/tokens.ts` | Toda vez que escrever CSS de layout |
| Fontes carregadas | `app/layout.tsx` (`next/font/google`) → descrito em `03-typography.md` | Ao mexer em `font-family` |
| Tamanho/peso de texto | `03-typography.md` | Ao criar headers, body, dados, captions |
| Altura de linha de inbox / kanban / tabela | `04-density-aerada.md` | Ao desenhar listas e grids |
| Qual ícone usar para feature X | `05-iconography-phosphor.md` | Ao adicionar novo ícone |
| Variant/state de um componente shadcn | `06-components.md` | Antes de criar novo componente |
| Duração e curva de animação | `07-motion-language.md` | Toda vez que adicionar `transition` ou `animation` |
| Copy de erro/sucesso/empty | `08-voice-and-tone.md` | Ao escrever microcopy |
| "Posso usar X?" (Inter, gradient roxo, etc.) | `09-anti-patterns.md` | Quando em dúvida sobre uma escolha |

## Source of truth (código)

- `app/globals.css` — os tokens que o produto pinta (`:root`, `[data-theme="light"]`, `[data-theme="dark"]`, `@theme inline`)
- `app/layout.tsx` — fontes do produto via `next/font/google` (Epilogue, Urbanist, IBM Plex Mono)
- `lib/branding/regua-do-produto.ts` — a régua do CSS congelada para o runtime (**gerado**; `tests/unit/branding-regua-do-produto.test.ts` compara com o CSS)
- `app/design/lib/tokens.ts` — espelho em TypeScript para o showcase (cor, spacing, radius, shadow, motion), com as paletas candidatas da v1.0 para comparação
- `app/design/lib/fonts.ts` — fontes das paletas candidatas (o par do produto vem do root layout)
- `app/design/showcase.css` — CSS vars `.ds-*` do showcase
- `app/design/` — showcase navegável em `/design`

## Versionamento

- **v1.0** (2026-04-28) — paleta Sage, tipografia Atkinson, densidade Aerada, iconografia Phosphor lockados (upstream DeskcommCRM).
- **Tema Marca Jo** (2026-09-13, este fork) — troca de paleta (Sage → petróleo do Jo OS), tipografia (Atkinson → Urbanist/Epilogue), raios (4/8/12/16 → 6/10/14/18) e tinta das sombras. Princípios, densidade, iconografia, motion e voz **não** mudaram. Detalhe em `00-overview.md` § Versionamento.
- Mudanças de versão maior exigem PR + revisão do design owner. Patches (ajuste de hex em ±2 luminosidade, novos ícones, novos exemplos de microcopy) podem ir direto — e todo ajuste de hex passa primeiro pelo CSS, depois pela doc.
