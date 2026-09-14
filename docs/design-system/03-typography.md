# 03 — Tipografia

> **Source of truth:** `app/layout.tsx` (`epilogue`, `urbanist`, `plexMono` via `next/font/google`) e `app/globals.css` (`--font-sans`, `--font-display`, `--font-mono` no `@theme inline`; `h1..h6` no `@layer base`). Espelho no showcase: `app/design/lib/tokens.ts` → `TYPOS["epilogue-urbanist"]`.
>
> **Histórico:** a v1.0 upstream usava Atkinson Hyperlegible para display + body. O par abaixo é o do tema Marca Jo (2026-09-13, `00-overview.md` § Versionamento); Atkinson continua no showcase (`TYPOS.atkinson`) só para comparação.

## Por que Urbanist + Epilogue

O DeskcommCRM carrega a **mesma dupla do Jo OS**, o sistema interno da Jordão Aceleração IA: **Urbanist** nos títulos (`h1`–`h6`, utilitário `font-display`) e **Epilogue** no corpo (`font-sans`, o default do `<body>`). A razão primeira é identidade — o CRM e o sistema interno são a mesma casa, e a tipografia é o que o olho reconhece antes de ler qualquer palavra.

O que o par entrega, além da identidade:

- **Duas famílias, um mesmo desenho.** As duas são sans geométrico-humanistas com x-height generosa; a diferença entre título e corpo é de *voz* (Urbanist mais aberta e larga, Epilogue mais contida), não de gênero. A hierarquia continua vindo de peso, tamanho e whitespace — combina com Aerada.
- **Faixa de pesos completa.** Epilogue carrega 300–700 e Urbanist 400–800: existe semibold de verdade (500/600), que Atkinson não tinha. Use-os; não simule peso com tamanho.
- **Anti-genérica.** Nem Inter, nem Geist, nem Space Grotesk (`09-anti-patterns.md` § 1–2). Urbanist/Epilogue não são o par default de nenhum template de SaaS.
- **Legibilidade em 12–13px.** Ambas têm contraformas abertas e mantêm-se legíveis em timestamp, helper e dado de tabela; o `letter-spacing: -0.015em` dos títulos (regra do Jo OS) só se aplica de `h1` a `h6`.
- **`ss01` ligado no corpo.** `font-feature-settings: "rlig" 1, "calt" 1, "ss01" 1` no `<body>` — é o conjunto que o Jo OS usa.

O que se **perdeu** em relação à v1.0, e é declarado: Atkinson Hyperlegible disambiguava `0`/`O`, `1`/`l`/`I` por desenho. Epilogue e Urbanist não têm essa garantia. Por isso **todo identificador (pedido, código de cliente, chave Pix) vai em IBM Plex Mono** (`mono-data`), onde a distinção existe — na v1.0 isso era recomendação; agora é regra.

A fonte para **dados monoespaçados** continua **IBM Plex Mono** (`code`, `kbd`, `pre`, `samp` e a classe `font-mono`) — escolhida por ter sensibilidade humanista sem cair em JetBrains Mono (saturação developer-tools) nem Fira Code (ligatures que confundem em UI).

## Stack completo

O que `app/globals.css` declara (a pilha de fallback é a real, não abreviada):

```css
/* @theme inline — vira os utilitários font-sans / font-display / font-mono */
--font-sans:    var(--font-epilogue), ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
--font-display: var(--font-urbanist), ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
--font-mono:    var(--font-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;

/* @layer base */
body            { font-family: var(--font-epilogue), …; font-feature-settings: "rlig" 1, "calt" 1, "ss01" 1; }
h1, h2, h3, h4, h5, h6 { font-family: var(--font-urbanist), …; letter-spacing: -0.015em; }
code, kbd, pre, samp   { font-family: var(--font-mono), …; font-variant-numeric: tabular-nums; }
```

`--font-epilogue`, `--font-urbanist` e `--font-mono` são injetados por `next/font/google` em `app/layout.tsx` (classe no `<html>`), em build time — a imagem self-host não depende de CDN de fonte.

**Pesos carregados** (Epilogue, corpo): 300, 400, 500, 600, 700 — subsets `latin` + `latin-ext` (acentos do português).

**Pesos carregados** (Urbanist, títulos): 400, 500, 600, 700, 800.

**Pesos carregados** (IBM Plex Mono): 400 — default mono; 500 — emphasis em mono (raro).

Peso que não está na lista não existe na tela: o navegador sintetiza (falso-bold) ou cai no vizinho. Pedir 900 em Urbanist rende 800.

## Escala tipográfica

Modular ratio: **1.250 (minor third)**, com ajustes manuais em alguns stops para alinhar pixel-grid.

| Token | Tamanho | Line-height | Peso | Tracking | Uso |
|-------|---------|-------------|------|----------|-----|
| `display-xl` | 48px | 56px | 700 | -1% | Hero raríssimo (página de boas-vindas) |
| `display-lg` | 36px | 44px | 700 | -0.5% | Hero de página de feature, marketing-style |
| `display-md` | 28px | 36px | 700 | 0 | Header de view (`Inbox`, `Kanban`) |
| `display-sm` | 24px | 32px | 700 | 0 | Header de seção em página densa |
| `h1` | 20px | 28px | 700 | 0 | Títulos de card grande, modal title |
| `h2` | 18px | 24px | 700 | 0 | Subtítulo, header de coluna |
| `h3` | 16px | 22px | 700 | 0 | Card title, group label em form |
| `body-lg` | 16px | 24px | 400 | 0 | Body de prosa (descrição, comentário) |
| `body` | 14px | 20px | 400 | 0 | **Default UI** — labels, copy de botão, item de lista |
| `body-sm` | 13px | 18px | 400 | 0 | Helper, preview de mensagem em inbox, secondary text |
| `caption` | 12px | 16px | 400 | 0.5% | Timestamp, badge label, microcopy |
| `mono-data` | 13px | 18px | 400 | 0 | **IBM Plex Mono** — IDs, valores, datas tabulares |

**Regras de uso:**

- Não invente tamanhos intermediários. Se 14 e 16 não cabem, repense o layout.
- `tracking` (letter-spacing) só nos extremos da escala: negativo nos display (compactar), positivo no caption (legibilidade).
- **Line-height nunca abaixo de 1.4** em prosa (`body-lg`, `body`). UI compacta pode ir até 1.35 (caption).

## Numerais

Epilogue e Urbanist suportam **tabular nums** via `font-variant-numeric`. Aplicado obrigatoriamente em:

```css
.tabular {
  font-variant-numeric: tabular-nums;
}
```

**Quando usar tabular-nums (largura igual por dígito):**
- IDs de pedido (`#12.443`)
- Preços (`R$ 247,90`)
- Datas e horários (`14:32`, `28/04`)
- Contadores em colunas (`Pedidos: 1.247`)
- Qualquer número em tabela ou lista alinhada

**Quando manter proporcional (default):**
- Números em prosa (`Você tem 3 conversas pendentes`)
- Números pequenos isolados em meio a texto

Em IBM Plex Mono o tabular já é nativo (toda mono é tabular).

## Itálico

Itálico tem **uso semântico**, não decorativo:

✅ Sim — citar texto literal (`A cliente disse: "ainda não chegou"`)
✅ Sim — termo técnico em primeira ocorrência
✅ Sim — placeholder explicativo (`exemplo: nome do produto`)

❌ Não — destacar palavras pra "dar charme"
❌ Não — em headings (nunca)
❌ Não — em microcopy de botão

## Hierarquia em UI real

Exemplo canônico: **item de inbox**.

```tsx
<div className="ds-list-item">
  <Avatar />
  <div className="body">
    <span className="title">João Silva — Pedido #12.443</span>          {/* body, weight 700 implicit via .title */}
    <span className="preview">"Olá, ainda não recebi rastreio…"</span>  {/* body-sm, text-muted */}
  </div>
  <div className="meta">
    <span className="ts tabular">14:32</span>                            {/* caption, tabular, mono opcional */}
    <Badge variant="success">Resolvido</Badge>                           {/* caption peso 500 */}
  </div>
</div>
```

Detalhes a observar:
- O nome da pessoa e o ID do pedido convivem na mesma linha porque hierarquia é dada por `weight` + `text-muted`, não por tamanho diferente.
- ID `#12.443` está em sans (Epilogue) com `font-variant-numeric: tabular-nums` porque é um número curto inline **só de dígitos**; quando vira coluna de tabela, ou quando mistura letras e dígitos (`Bl0OO1`), vira `mono-data` (Plex Mono) — é onde `0`/`O` e `1`/`l` se distinguem.
- Timestamp em `caption` + `tabular` para alinhar verticalmente entre rows.

Outro exemplo: **header de view**.

```tsx
<header>
  <h1 className="display-md">Inbox</h1>                {/* 28px / 700 */}
  <p className="body-sm text-muted">42 conversas abertas · 3 vencendo SLA</p>
</header>
```

## Acessibilidade

- **Tamanho mínimo:** 12px (`caption`). Abaixo disso só ícones com `aria-label`.
- **Line-height mínimo:** 1.4 em prosa, 1.35 em UI compacta.
- **Tracking:** já calibrado por escala. Não sobrescreva sem motivo (legível ou marketing).
- **Peso mínimo de leitura:** 400 sempre. Epilogue 300 está carregado, mas é para display grande (≥ 28px) em hero — nunca para texto lido.
- **Foco visual:** texto em `text-muted` (`#586674` light / `#9da6ad` dark) só pra UI 14px+; nunca aplicar a prosa longa. `text-subtle` (`#7c8c9c` / `#657381`) é só placeholder e ícone — 3.2:1 sobre o fundo claro não passa como texto.
- **Truncate:** sempre com `text-overflow: ellipsis` + `white-space: nowrap` + `min-width: 0`. Tooltip com texto completo no hover (`<Tooltip>` shadcn).

## Como consumir em código

```tsx
// Tailwind (mapeado no `@theme inline` de app/globals.css)
// `h1`–`h6` já recebem Urbanist pelo `@layer base`; `font-display` é para
// título que não é heading semântico (nome de card, valor grande).
<h1 className="text-display-md font-bold tracking-tight">Inbox</h1>
<div className="font-display text-2xl font-semibold">R$ 12.443,00</div>
<p className="text-body-sm text-muted">42 abertas</p>
<span className="font-mono text-mono-data tabular-nums">#12.443</span>

// CSS direto (estilos globais)
.title { font-family: var(--font-display); font-size: 28px; line-height: 36px; font-weight: 700; }
.id    { font-family: var(--font-mono);    font-size: 13px; line-height: 18px; font-variant-numeric: tabular-nums; }
```
