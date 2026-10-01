#!/usr/bin/env bash
# Proves that a manual update.sh and the agent.sh cron no longer step on each
# other, and that the cron header is written with the secret that is in .env.
#
#   bash tests/shell/update-lock-and-cron-secret.test.sh
#
# The timeline this reproduces was measured on a production VPS on 2026-09-29,
# updating v1.20.3 -> v2.0.0 by hand with `update.sh --to v2.0.0 --force`:
#
#   02:34:56  update.sh paused app/worker/scheduler and started the baseline
#   02:35:00  the agent.sh cron fired, swapped the leaked cron secret, ran
#             `dc up -d` (the OLD containers came back mid schema change) and
#             wrote .env.cron-drain with the new secret
#   02:36:52  update.sh step 7 rewrote .env.cron-drain with the secret its shell
#             had loaded at the start — the OLD one. The drain got 403.
#
# The real `_common.sh` and `agent.sh` run here; case 4 runs the real update.sh
# up to the lock. docker/crontab/curl/git are PATH doubles that log what they
# were asked to do. What is measured is the effect on disk (.env, the cron
# header, the marker) and the `up -d` calls — not the script text.
#
# The other update.sh bodies are small wrappers with the right NAME: it is by
# `$0` that `setup_event_log_drain_cron` decides it is the update.sh. The real
# body does git/pull/baseline, out of reach of this proof.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KIT="$ROOT/hostgator-setup-kit"
WORK="$(mktemp -d)"
[ -n "${KEEP:-}" ] || trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() { if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi; }

OLD="old-secret-that-went-to-syslog-a1b2c3"
URL="https://crm.example.com.br"

HAVE_FLOCK=1
if ! command -v flock >/dev/null 2>&1; then
  # CI (Ubuntu) has util-linux. Skipping there would be a green that measured
  # nothing, so only a developer machine without flock may skip.
  [ -n "${CI:-}" ] && { echo "✗ flock is missing on CI — the lock cases cannot run"; exit 1; }
  HAVE_FLOCK=0
  echo "  (flock not installed: lock cases skipped — install util-linux to run them)"
fi

mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
case " $* " in
  *" exec "*) printf 'healthy\n{}\n'; exit 0 ;;
  *" up "*)   printf '%s\n' "$*" >> "$DOUBLE_LOG/docker-up"; exit 0 ;;
  *" stop "*) printf '%s\n' "$*" >> "$DOUBLE_LOG/docker-stop"; exit 0 ;;
esac
exit 0
STUB
cat > "$WORK/bin/crontab" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  -l) [ -f "$DOUBLE_LOG/crontab" ] || { echo "no crontab for root" >&2; exit 1; }; cat "$DOUBLE_LOG/crontab" ;;
  -)  cat > "$DOUBLE_LOG/crontab.new" && mv "$DOUBLE_LOG/crontab.new" "$DOUBLE_LOG/crontab" ;;
esac
STUB
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf '{"data":{"update_requested":false}}\n200'
STUB
cat > "$WORK/bin/git" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in rev-parse) echo abc1234 ;; esac
exit 0
STUB
# The kit refuses ARM (the Mac running the suite); the real VPS is x86_64.
cat > "$WORK/bin/uname" <<'STUB'
#!/usr/bin/env bash
echo x86_64
STUB
chmod +x "$WORK/bin/"*

# new_project <name> <update.sh body: top|pause|nolock>
#   top    — the new update.sh: holds the lock from its first lines
#   pause  — the PREVIOUS update.sh body (no lock at the top) calling the new
#            `pausar_o_que_fala_com_o_banco`: the update that brings this fix
#   nolock — no lock anywhere: the production timeline, to prove defect (b)
# The crontab carries the legacy line with the secret written in it, so the
# agent.sh has a swap to make.
new_project() {
  local p="$WORK/$1"
  mkdir -p "$p/proj/hostgator-setup-kit" "$p/log"
  cp "$KIT/_common.sh" "$KIT/_i18n.sh" "$KIT/agent.sh" "$KIT/update.sh" "$KIT/manutencao.sh" \
    "$p/proj/hostgator-setup-kit/"
  : > "$p/proj/docker-compose.prod.yml"
  printf 'INTERNAL_SECRET="scheduler-secret-9z9z"\nINTERNAL_CRON_SECRET="%s"\nNEXT_PUBLIC_APP_URL="%s"\n' "$OLD" "$URL" > "$p/proj/.env"
  printf '* * * * * curl -fsS -H "Authorization: Bearer %s" "%s/api/v1/cron/event-log-drain" >/dev/null 2>&1\n' "$OLD" "$URL" > "$p/log/crontab"
  local hold=""
  case "$2" in
    top)    hold='hold_update_lock || die "lock refused"' ;;
    pause)  hold='pausar_o_que_fala_com_o_banco' ;;
    nolock) hold=':' ;;
  esac
  # Signals it is in the middle of the update (log/held), waits for the test to
  # let it go (log/release), then runs step 7 as the real update.sh does.
  cat > "$p/proj/hostgator-setup-kit/manual-update-body.sh" <<BODY
set -euo pipefail
source "\$(dirname "\$0")/_common.sh"
enter_project
psql_run() { :; }
$hold
: > "\$DOUBLE_LOG/held"
for _ in \$(seq 1 300); do [ -e "\$DOUBLE_LOG/release" ] && break; sleep 0.1; done
setup_event_log_drain_cron
BODY
}

# The wrapper must be NAMED update.sh; the real one is kept for case 4.
use_wrapper() {
  local k="$WORK/$1/proj/hostgator-setup-kit"
  mv "$k/update.sh" "$k/real-update.sh"
  mv "$k/manual-update-body.sh" "$k/update.sh"
}

env_run() {  # env_run <case> <command...>
  local p="$WORK/$1"; shift
  ( cd "$p/proj" && env PATH="$WORK/bin:$PATH" DOUBLE_LOG="$p/log" "$@" )
}

wait_for() {  # wait_for <file> — up to 15s
  local _
  for _ in $(seq 1 150); do [ -e "$1" ] && return 0; sleep 0.1; done
  return 1
}

env_value() { grep -E "^$2=" "$WORK/$1/proj/.env" | tail -1 | cut -d= -f2- | tr -d '"'; }
ups() { [ -f "$WORK/$1/log/docker-up" ] && wc -l < "$WORK/$1/log/docker-up" | tr -d ' ' || echo 0; }
header() { cat "$WORK/$1/proj/.env.cron-drain" 2>/dev/null; }
header_matches_env() { [ "$(header "$1")" = "Authorization: Bearer $(env_value "$1" INTERNAL_CRON_SECRET)" ]; }

# manual_update_with_agent_mid_way <case> — the production timeline: the manual
# update is running, the agent.sh cron fires, then the update finishes.
manual_update_with_agent_mid_way() {
  local c="$1" p="$WORK/$1"
  env_run "$c" bash hostgator-setup-kit/update.sh > "$p/log/out-update" 2>&1 &
  local pid=$!
  wait_for "$p/log/held" || echo "    (update.sh never reached the middle — see $p/log/out-update)"
  env_run "$c" bash hostgator-setup-kit/agent.sh > "$p/log/out-agent" 2>&1
  UPS_WHILE_UPDATING="$(ups "$c")"
  AGENT_SECRET="$(env_value "$c" INTERNAL_CRON_SECRET)"
  : > "$p/log/release"
  wait "$pid"; UPDATE_RC=$?
}

if [ "$HAVE_FLOCK" = 1 ]; then
  echo "1. manual update.sh (new body) holds the lock; the agent.sh cron fires mid-update"
  new_project one top; use_wrapper one
  manual_update_with_agent_mid_way one
  check "agent.sh restarted nothing while the update ran (0 up -d)" [ "$UPS_WHILE_UPDATING" = 0 ]
  check "agent.sh did not swap the secret mid-update" [ "$AGENT_SECRET" = "$OLD" ]
  check "the update finished (exit 0)" [ "$UPDATE_RC" = 0 ]
  check "the update itself swapped the leaked secret" [ "$(env_value one INTERNAL_CRON_SECRET)" != "$OLD" ]
  check "exactly one up -d: the update's own" [ "$(ups one)" = 1 ]
  check "the cron header carries the secret that is in .env" header_matches_env one

  echo "2. the update that BRINGS the fix: previous body, new pause function"
  new_project two pause; use_wrapper two
  manual_update_with_agent_mid_way two
  check "agent.sh restarted nothing while the database was paused" [ "$UPS_WHILE_UPDATING" = 0 ]
  check "agent.sh did not swap the secret mid-update" [ "$AGENT_SECRET" = "$OLD" ]
  check "the update finished (exit 0)" [ "$UPDATE_RC" = 0 ]
  check "the cron header carries the secret that is in .env" header_matches_env two

  echo "   control: the same agent.sh with no update running DOES swap"
  # Without this, cases 1 and 2 would pass on an agent.sh that never swaps.
  new_project ctl top
  env_run ctl bash hostgator-setup-kit/agent.sh > "$WORK/ctl/log/out-agent" 2>&1
  check "the secret changed" [ "$(env_value ctl INTERNAL_CRON_SECRET)" != "$OLD" ]
  check "and the containers were recreated (1 up -d)" [ "$(ups ctl)" = 1 ]

  echo "3. screen button: update.sh runs as a child of the agent.sh that holds the lock"
  # Every published agent.sh takes the lock before starting update.sh, and the
  # ones already on disk do not export DESKCOMM_UPDATE_LOCK_HELD. flock(2) makes
  # a second open() of the file an independent lock even in a child — without
  # the DESKCOMM_AGENT_REPORT exit, the pause would wait on its own parent.
  new_project three pause; use_wrapper three
  : > "$WORK/three/log/release"
  START=$SECONDS
  env_run three env -u DESKCOMM_UPDATE_LOCK_HELD UPDATE_LOCK_WAIT_SECONDS=5 DESKCOMM_AGENT_REPORT=1 \
    bash -c 'exec 9>.update.lock; flock -n 9 || exit 99; bash hostgator-setup-kit/update.sh' \
    > "$WORK/three/log/out-update" 2>&1
  RC=$?
  check "it finished (exit 0), not waiting on its parent" [ "$RC" = 0 ]
  check "in under the lock wait (no deadlock)" [ $((SECONDS - START)) -lt 5 ]
  check "and it paused the CRM for the database" grep -q 'stop app worker scheduler' "$WORK/three/log/docker-stop"

  echo "4. the REAL update.sh refuses to run beside another update"
  new_project four top
  env_run four bash -c 'exec 9>.update.lock; flock -n 9 || exit 99; : > "$DOUBLE_LOG/held"; sleep 8' &
  HOLDER=$!
  wait_for "$WORK/four/log/held"
  cp "$WORK/four/log/crontab" "$WORK/four/log/crontab.before"
  env_run four env UPDATE_LOCK_WAIT_SECONDS=1 bash hostgator-setup-kit/update.sh --to v9.9.9 \
    > "$WORK/four/log/out-update" 2>&1
  RC=$?
  kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
  check "it stopped (exit != 0)" [ "$RC" != 0 ]
  check "and said another update is running" grep -q 'Outra atualização segue rodando' "$WORK/four/log/out-update"
  check "before touching anything: no up -d" [ "$(ups four)" = 0 ]
  check "before touching anything: crontab unchanged" cmp -s "$WORK/four/log/crontab" "$WORK/four/log/crontab.before"
  check "before touching anything: never looked for updates" bash -c '! grep -q "Procurando atualizações" "$1"' _ "$WORK/four/log/out-update"

  echo "   control: with the lock free, the real update.sh gets past it"
  new_project four-free top
  env_run four-free env UPDATE_LOCK_WAIT_SECONDS=1 bash hostgator-setup-kit/update.sh --to v9.9.9 \
    > "$WORK/four-free/log/out-update" 2>&1
  check "it went on to look for updates" grep -q 'Procurando atualizações' "$WORK/four-free/log/out-update"
  check "without the 'another update' message" bash -c '! grep -q "Outra atualização" "$1"' _ "$WORK/four-free/log/out-update"
fi

echo "5. no lock at all (the production timeline): the cron header follows .env, not the shell"
# Defect (b) on its own: even if some process swaps the secret while update.sh
# runs, step 7 must write what is on disk. This one needs no flock.
new_project five nolock; use_wrapper five
manual_update_with_agent_mid_way five
check "the scenario happened: agent.sh swapped mid-update" [ "$AGENT_SECRET" != "$OLD" ]
check "the update finished (exit 0)" [ "$UPDATE_RC" = 0 ]
check "the cron header carries the agent's NEW secret, not the one loaded at start" header_matches_env five
check "the old secret is nowhere in the header" bash -c '! grep -q "$1" "$2"' _ "$OLD" "$WORK/five/proj/.env.cron-drain"

echo "6. an empty read from .env never erases a good secret in the shell"
mkdir -p "$WORK/six"
reload_in() {  # reload_in <.env content> → INTERNAL_CRON_SECRET after the reload
  printf '%s\n' "$1" > "$WORK/six/.env"
  ( set +eu; source "$KIT/_common.sh" >/dev/null 2>&1; set +e
    PROJECT_DIR="$WORK/six" INTERNAL_CRON_SECRET="good-secret-in-shell"
    reload_cron_secrets_from_env; printf '%s' "$INTERNAL_CRON_SECRET" )
}
check "key present but empty: the shell keeps its secret" [ "$(reload_in 'INTERNAL_CRON_SECRET=""')" = "good-secret-in-shell" ]
check "key absent: the shell keeps its secret" [ "$(reload_in 'OTHER=1')" = "good-secret-in-shell" ]
check "control: a value on disk wins over the shell" [ "$(reload_in 'INTERNAL_CRON_SECRET="newer-on-disk"')" = "newer-on-disk" ]
check "a value with \$ and quotes reads as load_env wrote it" \
  [ "$(reload_in 'INTERNAL_CRON_SECRET="a\$b\"c"')" = 'a$b"c' ]

echo "7. without flock the update says the lock is off, instead of a silent ok"
# A PATH with the basics and no flock — the state of a host without util-linux.
mkdir -p "$WORK/noflock"
for tool in bash dirname uname sed grep cat tr date mkdir rm basename head cut wc; do
  src="$(command -v "$tool" 2>/dev/null)" && ln -sf "$src" "$WORK/noflock/$tool"
done
NOFLOCK_OUT="$(cd "$WORK" && env PATH="$WORK/noflock" "$WORK/noflock/bash" -c '
  source "$1/_common.sh" >/dev/null 2>&1; set +e
  PROJECT_DIR="$2"; hold_update_lock; echo "rc=$?"; hold_update_lock; echo "rc=$?"' _ "$KIT" "$WORK/six" 2>&1)"
check "it still goes on (rc=0)" bash -c '[ "$(printf "%s\n" "$1" | grep -c "^rc=0")" = 2 ]' _ "$NOFLOCK_OUT"
check "and warns that the update lock could not be turned on" bash -c 'printf "%s" "$1" | grep -q "trava de atualização"' _ "$NOFLOCK_OUT"
check "once, not on every call" [ "$(printf '%s\n' "$NOFLOCK_OUT" | grep -c 'trava de atualização')" = 1 ]

echo
if [ "$FAILS" -gt 0 ]; then echo "✗ $FAILS failure(s)"; exit 1; fi
echo "✓ update lock and cron secret: all cases passed"
