# BERSEBA.md — what this repository changes relative to upstream

This repository is a lean fork of [DeskcommCRM](https://github.com/melgarafael/DeskcommCRM)
(MIT), maintained by Berseba for the CRM at `crm.grupoberseba.com.br`. `main` tracks the latest
upstream release plus **five** commits of ours, listed below. Everything else is upstream's and is
not edited here.

## Language

Everything developer-facing is in **English**: code, comments, commit messages, branches, tags,
workflows, tests, PR bodies and this file. **Portuguese only where the customer or the VPS
operator reads it on screen**: UI copy, `.changes/` fragments and the CHANGELOG (the product
renders them). Text upstream already wrote in Portuguese stays as is.

## Customizations kept on `main`

| What | Why | Where |
|---|---|---|
| **Clinical brakes** — a medical emergency reported by the contact goes to a human at once (with a fixed message: 192/SAMU); the AI reply is vetoed if it states a diagnosis, prescribes or promises a cure | Clínica FitVision serves patients over WhatsApp; upstream only has a generic urgency signal to prioritise alerts, not a handoff nor a veto | `lib/agent-engine/guardrails/escopo-clinico.ts`, `lib/agent-engine/guardrails/camadas-da-org.ts` (`lerNichoDaOrg`), `lib/ai/handoff/{triggers,regex}.ts`, `lib/escalacao/aviso-ao-lead.ts`, `lib/agent-engine/agent/inbound-turn.ts`, `lib/agent-engine/guardrails/before-send.ts` |
| **Organization niche** — the Settings › Security screen that picks the niche; `saude` turns the brakes above on | Configuration before code: the niche lives in `organizations.settings.nicho`, no migration | `lib/organizacoes/nicho.ts`, `app/api/v1/settings/nicho/route.ts`, `app/app/settings/security/{page,_client}.tsx`, `lib/audit/actions.ts` (`org.nicho_changed`, at the **top** of the list: upstream appends at the bottom) |
| **Spanish** for the niche copy | The `i18n-espanhol-cobre-a-tela` gate requires it | `lib/i18n/dicionario.ts` |
| **Berseba images and repository** — `ghcr.io/berseba/*` and `github.com/berseba/berseba-crm` | The kit and the compose must pull what our CI publishes; CHANGELOG compare links must point at our tags | `hostgator-setup-kit/{_common,install,comecar,diagnostico}.sh`, `docker-compose.prod.yml`, `.env.hostgator.example`, `Dockerfile*` (source label), `scripts/cortar-release.ts`, `tests/unit/_identidade-deste-repo.ts` |
| **Worker with 1 GB** and Node heap at 768 MB | At 512 MB the worker restarted every ~10 min on the VPS | `docker-compose.prod.yml`, `worker` service |

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
