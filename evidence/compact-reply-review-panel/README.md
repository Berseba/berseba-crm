# Compact reply suggestion panel + Ficha door on tablets (PR #47)

Screen proof in a fresh local install: `baseline.sql` on an empty Supabase (pg15), production
build (`pnpm e2e:build` + `next start`), `INTERNAL_AGENT_RUN_STUB=true` so the real route
generates the suggestion. Driven by Playwright as an attendant would. Heights and overflow
measured with `getBoundingClientRect`, not by eye. The proof script was temporary.

## Suggestion panel — first pass (expand, collapse, reload, approve)

| 1440×900 | 390×844 |
|---|---|
| ![](desktop-1-expanded.png) expanded, 190 px (21%) | ![](mobile-1-expanded.png) expanded, 266 px (31%) |
| ![](desktop-2-collapsed.png) collapsed, 54 px (6%) | ![](mobile-2-collapsed.png) collapsed, 62 px (7%) |
| ![](desktop-3-after-reload-still-collapsed.png) reload keeps it collapsed | ![](mobile-3-after-reload-still-collapsed.png) reload keeps it collapsed |
| ![](desktop-4-approved.png) approve → 200 | ![](mobile-4-approved.png) approve → 200 |

## Suggestion panel — after review fixes (no element past the panel's right edge at any width)

| Width | Expanded | Collapsed |
|---|---|---|
| 390 | ![](panel-phone-390-expanded.png) | ![](panel-phone-390-collapsed.png) |
| 820 (panel only 208 px wide) | ![](panel-tablet-portrait-820-expanded.png) | ![](panel-tablet-portrait-820-collapsed.png) |
| 1024 | ![](panel-tablet-landscape-1024-expanded.png) | ![](panel-tablet-landscape-1024-collapsed.png) |
| 1180 | ![](panel-laptop-1180-expanded.png) | ![](panel-laptop-1180-collapsed.png) |
| 1440 | ![](panel-desktop-1440-expanded.png) | ![](panel-desktop-1440-collapsed.png) |

A failed send at 360 px, collapsed: the reason stays visible and the draft text stays hidden —
![](phone-360-failed-collapsed.png)

## Ficha (contact panel: tags, funnel) by width

**Before** (upstream `InboxLayout`): at 820, 1024 and 1180 px there is no "Ficha" button and no
right column — the Playwright check "no Ficha door at this width" fails at those three widths
and passes at 390 and 1440.

![](ficha-tablet-portrait-820-0-before-no-door.png) ![](ficha-tablet-landscape-1024-0-before-no-door.png)

**After**: the "Ficha" button opens the sheet below 1280 px; a tag typed there is saved
(`conversations.tags` read back from the database) at every width.

| Width | Door | Tag added |
|---|---|---|
| 390 | ![](ficha-phone-390-1-door.png) | ![](ficha-phone-390-2-tag-added.png) |
| 820 | ![](ficha-tablet-portrait-820-1-door.png) | ![](ficha-tablet-portrait-820-2-tag-added.png) |
| 1024 | ![](ficha-tablet-landscape-1024-1-door.png) | ![](ficha-tablet-landscape-1024-2-tag-added.png) |
| 1180 | ![](ficha-laptop-1180-1-door.png) | ![](ficha-laptop-1180-2-tag-added.png) |
| 1440 | right column, no button | ![](ficha-desktop-1440-2-tag-added.png) |
