# BERSEBA.md — what this repository changes relative to upstream

This repository is a lean fork of [DeskcommCRM](https://github.com/melgarafael/DeskcommCRM)
(MIT), maintained by Berseba for the CRM at `crm.grupoberseba.com.br`. `main` tracks the latest
upstream release plus the customizations listed below (no count here: it rots). Everything else is upstream's and is
not edited here.

## Language

Everything developer-facing is in **English**: code, comments, commit messages, branches, tags,
workflows, tests, PR bodies and this file. **Portuguese only where the customer or the VPS
operator reads it on screen**: UI copy, `.changes/` fragments and the CHANGELOG (the product
renders them). Text upstream already wrote in Portuguese stays as is.

## Customizations kept on `main`

| What | Why | Where |
|---|---|---|
| **Clinical brakes** — a medical emergency reported by the contact goes to a human at once (with a fixed message: 192/SAMU). The diagnosis/prescription/cure veto is **upstream's** `clinical_claim` (layer `afirmacao_clinica`; its fail-safe opens a case after 2 vetoes only when the agent has `cases_enabled`), plus our physiotherapy/pilates vocabulary in one fenced block of its detector (a bare drug name is information on purpose; a use/recommending verb or an efficacy claim bars) and a readable `vetoReason` sentence for the lead timeline | Clínica FitVision serves patients over WhatsApp; upstream only has a generic urgency signal to prioritise alerts, not a handoff, and its clinical vocabulary is dermatology: before the port it let 9 of our 12 physio veto cases through. Our own `clinical_scope` gate (chain v9) was removed in #35 — the chain is upstream's again | `lib/ai/handoff/{medical-emergency,regex}.ts`, `lib/agent-engine/guardrails/camadas-da-org.ts` (`lerNichoDaOrg`), `lib/agent-engine/agent/inbound-turn.ts`, `workers/ai-response-worker.ts` (legacy worker, inert since upstream v1.17.0), `lib/escalacao/aviso-ao-lead.ts`, `lib/agent-engine/guardrails/afirmacao-clinica.ts` (the `Berseba` block + 3 small hooks), `lib/agent-engine/guardrails/afirmacao-clinica.berseba.test.ts`, `lib/leads/veto-activity.ts` (one `clinical_claim` line) |
| **Organization niche** — the Settings › Security screen that picks the niche. `saude` arms the emergency handoff and, when the organization never chose it, switches upstream's `afirmacao_clinica` layer on (an explicit choice is never overwritten — while the niche is `saude` and the layer is off, Settings › Security shows a persistent notice; leaving `saude` leaves the layer as is; read-time default proposed in #43) | Configuration before code: the niche lives in `organizations.settings.nicho`, no migration. The write is one transaction on the raw pool that merges the key in the UPDATE (#37): saving the niche never drops another `settings` key. The other writers of `settings` are still read-spread-write and can still drop the niche (#41) | `lib/organizacoes/{nicho,save-niche}.ts`, `app/api/v1/settings/nicho/route.ts`, `tests/invariants/save-niche.test.ts`, `app/app/settings/security/{page,_client}.tsx`, `app/app/settings/security/niche-picker.test.tsx`, `lib/audit/actions.ts` (`org.nicho_changed`, at the **top** of the list: upstream appends at the bottom) |
| **Spanish** for the niche copy | The `i18n-espanhol-cobre-a-tela` gate requires it | `lib/i18n/dicionario.ts` |
| **Berseba images and repository** — `ghcr.io/berseba/*` and `github.com/berseba/berseba-crm` | The kit and the compose must pull what our CI publishes; CHANGELOG compare links must point at our tags | `hostgator-setup-kit/{_common,install,comecar,diagnostico}.sh`, `docker-compose.prod.yml`, `.env.hostgator.example`, `Dockerfile*` (source label), `scripts/cortar-release.ts`, `tests/unit/_identidade-deste-repo.ts` |
| **Update kit: one update at a time, private backups** — `update.sh` takes the same `.update.lock` as `agent.sh`; backups are written `0600` in a `0700` folder | Production, 2026-09-29: the agent cron restarted the old containers in the middle of a manual update; the backups (database dump with customer data) were world-readable | `hostgator-setup-kit/{_common,update,backup,agent}.sh`, `tests/shell/{update-lock-and-cron-secret,backup-permissions}.test.sh`, `package.json` (`test:shell`) |
| **Vendored v1.63.0 `update.sh`** for the kit isolation check | `scripts/conferir-isolamento-do-kit.sh` replays the #1893 incident with upstream tag v1.63.0's `update.sh`, and this fork has no upstream tags (rule 6) | `tests/fixtures/kit/update-v1.63.0.sh.txt` (byte-identical copy, never edit), 3 lines in `scripts/conferir-isolamento-do-kit.sh` (`update_sh_da`) |
| **Flywheel ("Propostas") judged per organization** — at most `FLYWHEEL_BATCH_LIMIT` turns per org per run (latest turn of each contact, last 7 days, no verdict yet), one failure boundary per org | Production has 5 tenants: upstream's global "10 most recent turns" let the busiest org take every slot, re-paid the judge for the same turns every 6h when nothing new came in, and one org without budget or model aborted the run for all. Worth offering upstream | `lib/agent-engine/flywheel/live.ts` (`collectPendingTurns`, `judgeTurn`, the per-org loop in `runFlywheelOnce`), comment on `FLYWHEEL_BATCH_LIMIT` in `lib/agent-engine/env.ts` and both `.env*.example` |
| **Compact, collapsible reply suggestion panel** — the inbox "Sugestão para revisar" card is about half its old height (feedback field and buttons on one row, 2-line text box, the approval note only while pending) and collapses to a single line with the status and a preview; the choice is remembered per browser (`localStorage`) | Production feedback, 2026-10-09: the expanded card took half of the conversation pane and hid the message history. A candidate to propose upstream; drop this row if upstream ships an equivalent | `components/inbox/composer/ReplyReviewPanel.tsx`, `components/inbox/composer/ReplyReviewPanel.berseba.test.tsx`, `lib/i18n/dicionario.ts` and `lib/i18n/traducoes/{en,zh-CN}.json` (2 keys at the **top**) |
| **Ficha door on tablets** — the conversation top bar (back button + "Ficha") also shows between `md` and `xl` with only the "Ficha" button | Upstream hides that bar from `md` up but shows the contact column only from `xl`, so at 768–1279 px there was no way to open the contact panel (tags, funnel). Still the same on upstream main as of 2026-10-21 | `components/inbox/InboxLayout.tsx` (one `cn(...)` on the bar + `md:hidden` on the back button, marked `Berseba`) |
| **Worker with 1 GB** and Node heap at 768 MB | At 512 MB the worker restarted every ~10 min on the VPS | `docker-compose.prod.yml`, `worker` service |
| **Meta capture address is public, and hardened for it**: `/api/v1/anuncios/meta/<org>` passes the proxy without a session, like its Google sibling; the route checks the slug like the Google one and stores only the normalized UTM keys in `query_raw` | Upstream lists only the Google capture route in `PUBLIC_PATHS` (still true on its `main` of 2026-10-19), so every anonymous click on the Meta address got 401 `unauthenticated` before the route ran. Found by the Fiore Pilates site on 2026-10-19. Opening it made the route an anonymous write endpoint: unchecked slug in the rate-limit key, and the whole query string stored uncapped and forever (#66 review). Not sent upstream yet; drop this row once upstream ships all three changes (put the upstream link here when it exists) | `lib/auth/public-paths.ts` (one line under the Google one), `app/api/v1/anuncios/meta/[org]/route.ts` (slug check, `query_raw: utm`), `tests/unit/meta-ads-captura-de-utm.test.ts` (one assertion changed, one case added), `lib/auth/public-paths.berseba.test.ts` |
| **Ad capture rate limit: IP-wide bucket, and no blank 429 for people**: both capture routes check an IP-wide bucket (`capture-ip:<ip>`, 120 per minute, across organizations and platforms) before the per-(org, IP) one (`google-lp:` or `meta-lp:` + `<org>:<ip>`, 30 per minute; the slug is lowercased because `organizations.slug` is citext). The counted unit is the IPv4 address or the IPv6 /64 prefix (`ipBucket`). Over the IP-wide bucket the answer is a bare 429 before any database work; over the per-(org, IP) one the visitor still reaches WhatsApp without the ref. The first hit of each window, per bucket, logs `[anuncios.capture.rate-limit]` (never the IP). **Assumes a reverse proxy that overwrites `X-Forwarded-For`** (Caddy and Traefik do by default when no trusted proxies are configured; the front Caddy site on the production VPS has no `trusted_proxies`, checked 2026-10-20); without a proxy there is no header, the IP is null and nothing is counted | Upstream keyed the only bucket on the raw slug, so rotating it gave a fresh bucket and unbounded organization lookups per IP, and real visitors behind one mobile CGNAT address got a blank 429 (#67). Not sent upstream yet; drop this row when upstream ships an equivalent | `lib/plataformas-de-anuncio/capture-rate-limit.ts` (+ `.berseba.test.ts`), `app/api/v1/anuncios/{google,meta}/[org]/route.ts` (the rate-limit block and one `no_ref` branch), `tests/unit/{google-captura-identificadores,meta-ads-captura-de-utm}.test.ts` (rate-limit cases) |
| **Capture button text**: the Meta capture route accepts `&texto=<button message>` and uses it as the WhatsApp text: `<texto> [ref:XXXXXX]` when there is a ref, the bare `texto` on every path without one (no UTM, insert failed, per-(org, IP) bucket over); without `texto`, the configured template as before. `buttonText` strips every `[ref:...]` and `[dk1:...]` marker until none is left (one pass is bypassable: `[re[ref:]f:ABCDEF]` becomes a marker once the inner one goes; text that still changes after 8 passes is refused and the template is used), collapses whitespace and caps at 300 code points. The number is always the config's, and `texto` is never stored (not in `utm`, not in `query_raw`) | The Fiore site has several WhatsApp buttons with a message each, and the route answered all of them with the same template. The markers are stripped because the inbound side reads the first `[ref:]` it finds, so a forged one in a link would misattribute the lead. Google route untouched on purpose. Not sent upstream yet; drop this row when upstream ships an equivalent | `lib/plataformas-de-anuncio/button-text.ts` (+ `.berseba.test.ts`), `app/api/v1/anuncios/meta/[org]/route.ts` (the `texto` read, `mensagemSemRef` on the three no-ref paths, the ref message), `tests/unit/meta-ads-captura-de-utm.test.ts` (button text cases) |
| **Ad click cleanup (90 days)**: the daily `data-retention` cron deletes, from `google_ads_click_refs` and `meta_ads_click_refs`, the rows with `matched_at is null`, `tracking_link_id is null` and `created_at` older than 90 days (`UNMATCHED_CLICK_RETENTION_DAYS`). Per table: select 500 ids, delete them in chunks of 100 (re-checking both filters), at most 20 batches per run. A click that became a contact, and any click of a tracked link, is never touched. The step never throws: a failure is logged, audited (`retention.sweep_run` with `falhou: true`) and reported in the response (`unmatched_clicks_failures`), and the other steps run as usual | The Fiore privacy page promises 90 days for a click that never became a conversation, Google Ads only accepts offline conversions for clicks up to 90 days old, and migrations 0306 and 0381 left these rows forever as declared debt. No migration: no index covers `(matched_at, created_at)`, so add one only if the select gets slow. The 90 days promise is about the site's capture route, which never sets `tracking_link_id` (migration 0437, nullable in both tables, written only by `rastreio/links.ts`), so the tracked-link metrics (`fn_metricas_links_rastreaveis` counts these rows as `clicks`) are unchanged. Not sent upstream yet; drop this row when upstream ships an equivalent | `lib/plataformas-de-anuncio/click-ref-retention.ts` (+ `.berseba.test.ts`), `app/api/v1/cron/data-retention/route.ts` (one import, the hook `runUnmatchedClickRetention`, one `...cliques` in the response), `tests/unit/{retencao-poda-em-lotes,lgpd-varredura-completa-a-cascata}.test.ts` (one `vi.mock` block each, so their fake databases do not meet the new step) |
| **Conversation visibility resolved once per query** — `conversations_select` reads `fn_conversation_visibility_scope()` once per statement through one uncorrelated `(organization_id, slice) in (select …)` instead of calling `fn_can_view_conversation` per row, and `messages_select` wraps `fn_is_platform_admin()` in `(select …)`; same rules (parity pinned per user × organization, call counts measured) | Production, 2026-10-14: on PG17 the per-row SECURITY DEFINER call is re-planned every time (~14 ms per row); with ~700 conversations the inbox tab counts hit the 8 s `statement_timeout` ~1,300 times a day. Same count as an attendant: 3,994 ms → 18.7 ms. To be offered upstream; drop ours when theirs lands | `supabase/migrations/20261014190000_9001_conversation_visibility_once_per_query.sql`, its block in `supabase/baseline.sql` (right after the 0035 `messages_select` policy, not at the end of the file), `tests/invariants/conversation-visibility-once-per-query.test.ts` |

Any file in this table is a conflict candidate when upstream is synced. When resolving, the rule
is always the same: **upstream wins, our snippet goes alongside**, never rewriting theirs.

## What was left out (and where it is kept)

`archive/*` branches on GitHub, all from the common point with upstream (`53428145bb`, release
1.20.0). They receive no maintenance.

| Branch | Content |
|---|---|
| `archive/samuel-v1.20.3` (branch and tag) | The whole `main` of the previous fork, as it ran in production until the switch |
| `archive/shadow-mode` | Shadow mode per organization and per channel (the AI suggests, never sends). Nobody used it |
| `archive/ai-suggestion-bubble` | The AI suggestion as a bubble in the conversation thread |
| `archive/jo-os-theme` | The Jo OS visual theme. To be replaced by a Berseba theme through branding configuration |
| `archive/stage-suggestion`, `archive/fix-onboarding-rehearsal-status`, `archive/wip-external-calendar` | Unmerged work from the previous fork, kept for reference |

## Golden rules

1. **Configuration before code.** If `organizations.settings`, branding or an environment variable
   solves it, no code is written. Every line of ours is a line that can conflict on every sync.
2. **Only the storefront changes.** Image owner, repository URL, copy. **Never** rename an internal
   identifier: image names (`deskcommcrm`, `deskcomm-worker`…), cookies, folders, tables. Each one
   becomes an eternal conflict.
3. **Do not edit upstream's `README.md`** (nor `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`).
   What is ours lives here.
4. **Never build on the VPS.** Commit → PR → merge → CI publishes the image → the VPS pulls it with
   `update.sh`. See `docs/doctrine/packaging.md`.
5. **Every behaviour change ships its `.changes/` fragment** with the operator effect
   (`nada_mudou` / `capacidade_nova` / `exige_acao`). See `docs/doctrine/versionamento.md`.
6. **Never import upstream tags.** The `upstream` remote is added with `--no-tags`; the `v*` tags
   in this repository are ours only.
7. **Our entries go where upstream does not touch.** A list upstream extends at the bottom (e.g.
   `AUDIT_ACTIONS`) gets our entry at the top. It was the only conflict in the v1.61.0 merge rehearsal.
8. **Our migrations use the 9NNN range.** Upstream numbers sequentially (06xx in October 2026);
   any number in its range collides on a later sync, because the number must be unique across the
   chain. The `baseline.sql` block goes right after the definition it changes, never at the end
   of the file, where upstream appends on every release.

## Upstream sync

Every Monday at 09:00 (America/Sao_Paulo) the `.github/workflows/sync-upstream.yml` workflow
takes the latest upstream release, merges it into a `sync/upstream-vX.Y.Z` branch, writes the
`.changes/` fragment and opens the PR. CI measures it; a partner approves and merges. It can be
triggered by hand in Actions › sync-upstream › Run workflow.

- **Conflicts.** `CHANGELOG.md` is resolved automatically: ours wins. Any other file makes the PR
  go out with the fragment only, plus the commands to finish the merge in your clone. The rule when
  resolving is the one above: **upstream wins, our snippet goes alongside**.

## Versioning

- **The numbers are ours, not upstream's.** The version comes out of the product's own
  `scripts/cortar-release.ts`: newest `CHANGELOG.md` section + the highest impact among the
  fragments. Since Berseba's first cut carries `exige_acao` (image switch), it is born **2.0.0** and
  follows 2.x from there. Upstream is on 1.x; we never import its tags (`--no-tags`), so there is no
  tag collision, and the upstream version inside ours appears in the sync fragment title and in
  the release notes.
- **Every sync produces a release.** The sync fragment (`capacidade_nova`, or `exige_acao` when an
  upstream release asked for action) is what makes the next cut exist. Without a fragment,
  `release.yml` cuts nothing and the VPS never receives the update.
- **The VPS finds the release through GitHub**, not through a local tag: `update.sh` calls
  `ultima_release_estavel`, which reads `releases/latest` of `origin`. So the release must be
  published by `release.yml` (which also moves `stable` on the images), never a loose tag.

## Governance

- `main` is protected by a ruleset: PR required, 1 approval, the checks `verify`, `invariants`,
  `build-and-size`, `e2e` and `imagens-ok`, no force-push, no deletion.
- Bypass actors: the release App (always — it pushes the tag) and the technical lead
  (pull-request mode only: their PRs merge without a review, direct pushes to `main` stay blocked).
  Bypass also allows merging on red; waiting for green is the lead's discipline, not the machine's.
