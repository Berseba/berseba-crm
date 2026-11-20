#!/usr/bin/env bash
# Berseba (migrations 9005, 9009): update.sh takes the analytics contract views down
# before the baseline and brings them back after it, and neither step can fail
# the update.
#
#   bash tests/shell/analytics-views.test.sh
#
# The real `_analytics.sh` runs here with a `pg_container` double that records
# the SQL it was given (and fails on demand). The order inside update.sh is
# read from the script: the body that applies the baseline needs Docker and a
# database, out of reach of this proof. What the SQL does to a real Postgres is
# measured by tests/invariants/analytics-contract.test.ts.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KIT="$ROOT/hostgator-setup-kit"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() { if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi; }

# run <fail:0|1> <function> — sources the real file with doubles, calls one function.
run() {
  (
    set -e
    pg_container() { printf '%s\n' "${*: -1}" >> "$WORK/sql"; [ "$PG_FAIL" = 0 ]; }
    url_do_schema() { echo "postgresql://double"; }
    c_ylw() { printf '%s\n' "$*" >> "$WORK/warn"; }
    PG_FAIL="$1"
    # shellcheck source=/dev/null
    source "$KIT/_analytics.sh"
    "$2"
    echo "rc=$?" >> "$WORK/rc"
  )
  echo "subshell=$?" >> "$WORK/rc"
}

reset() { : > "$WORK/sql"; : > "$WORK/warn"; : > "$WORK/rc"; }

echo "1. drop and recreate call the baseline's functions, guarded"
reset
run 0 analytics_views_drop
run 0 analytics_views_recreate
check "drop calls analytics.fn_drop_views() only when it exists" \
  grep -q "to_regprocedure('analytics.fn_drop_views()') is not null then perform analytics.fn_drop_views()" "$WORK/sql"
check "recreate calls analytics.fn_recreate_views() only when it exists" \
  grep -q "to_regprocedure('analytics.fn_recreate_views()') is not null then perform analytics.fn_recreate_views()" "$WORK/sql"
check "no warning when the database answers" test ! -s "$WORK/warn"

echo "2. a failing database warns and never fails the update (set -e is on)"
reset
run 1 analytics_views_drop
run 1 analytics_views_recreate
check "both functions returned 0" test "$(grep -c '^rc=0$' "$WORK/rc")" = 2
check "the subshells under set -e survived" test "$(grep -c '^subshell=0$' "$WORK/rc")" = 2
check "the recreate warning tells how to repeat the step" grep -q "select analytics.fn_recreate_views();" "$WORK/warn"

echo "3. update.sh: sourced after the checkout, drop before the baseline, recreate after"
U="$KIT/update.sh"
line() { grep -nF -- "$1" "$U" | head -1 | cut -d: -f1; }
checkout=$(line 'git checkout --quiet "$TARGET_TAG"')
sourced=$(line 'source "$KIT_DIR/_analytics.sh"')
# The call sites carry this comment; the no-op fallbacks for a kit without
# _analytics.sh (`analytics_views_drop() { :; }`) do not.
drop=$(line 'analytics_views_drop  # Berseba (9005)')
baseline=$(line 'if reaplicar_baseline "$PROJECT_DIR/supabase/baseline.sql"')
recreate=$(line 'analytics_views_recreate  # Berseba (9005)')
policies=$(line 'E AS REGRAS DE ISOLAMENTO SÃO CONFERIDAS')
check "every anchor was found" test -n "$checkout" -a -n "$sourced" -a -n "$drop" -a -n "$baseline" -a -n "$recreate" -a -n "$policies"
check "_analytics.sh is sourced after the checkout" test "${sourced:-0}" -gt "${checkout:-0}"
check "the drop comes right before the baseline" test "$(( ${baseline:-0} - ${drop:-0} ))" = 1
check "the recreate comes after the baseline and its error report" \
  test "${recreate:-0}" -gt "${baseline:-0}" -a "${recreate:-0}" -lt "${policies:-0}"
check "update.sh calls each step once" \
  test "$(grep -c '^ *analytics_views_drop  #' "$U")" = 1 -a "$(grep -c '^ *analytics_views_recreate  #' "$U")" = 1
check "a kit without _analytics.sh still updates (no-op fallbacks)" \
  grep -q 'analytics_views_drop() { :; }' "$U"

echo "4. fn_recreate_views (migration 9009): one text in the chain and the baseline, every view commented and granted"
MIG="$(ls "$ROOT"/supabase/migrations/*_9009_analytics_bi_panel_views.sql 2>/dev/null | head -1)"
# The function body as written: from its `create or replace` to the `$fn$;` that closes it.
fn_body() { awk '/^create or replace function analytics\.fn_recreate_views\(\)/{p=1} p{print} p&&/^\$fn\$;$/{exit}'; }
fn_body < "${MIG:-/dev/null}" > "$WORK/mig_fn"
# The baseline's LAST definition is the one in force: the 9009 block.
awk '/^-- ---- analytics BI panel views \(migration 9009\) ----$/{p=1} p{print}' "$ROOT/supabase/baseline.sql" | fn_body > "$WORK/base_fn"
check "the 9009 migration exists" test -n "$MIG"
check "the function was found in both" test -s "$WORK/mig_fn" -a -s "$WORK/base_fn"
check "the baseline block carries the migration's function, byte for byte" cmp -s "$WORK/mig_fn" "$WORK/base_fn"
check "the 9009 block comes right after the 9005 block, before 9007" test "$(grep -o -E '^-- ---- [A-Za-z0-9 ]+ \(migration 900[579]\) ----$' "$ROOT/supabase/baseline.sql" | grep -o '900[579]' | tr -d '\n')" = 900590099007
check "the migration builds the views (last statement)" grep -q '^select analytics.fn_recreate_views();$' "${MIG:-/dev/null}"
VIEWS="$(grep -o -E '^  create view analytics\.v[0-9]+_[a-z_0-9]+' "$WORK/mig_fn" | sed 's/.*analytics\.//' | sort -u)"
check "it builds the six contract views" test "$(echo "$VIEWS" | tr '\n' ' ')" = "v1_atendimentos_dia v1_contagem_dia v1_conversas_abertas v1_leads_dia v1_reunioes_dia v1_tempo_resposta_dia "
for v in $VIEWS; do
  check "$v: security barrier, comment, revoke from the API roles, grant to analytics_reader" \
    bash -c "grep -A1 -q '^  create view analytics\.$v\$' '$WORK/mig_fn' \
      && grep -A1 '^  create view analytics\.$v\$' '$WORK/mig_fn' | grep -q 'with (security_barrier = true)' \
      && grep -q '^  comment on view analytics\.$v is\$' '$WORK/mig_fn' \
      && grep -q '^  revoke all on analytics\.$v from public, anon, authenticated, service_role;\$' '$WORK/mig_fn' \
      && grep -q '^  grant select on analytics\.$v to analytics_reader;\$' '$WORK/mig_fn'"
done

echo
if [ "$FAILS" -eq 0 ]; then echo "✓ analytics views around the baseline: all checks passed"; exit 0; fi
echo "✗ $FAILS check(s) failed"; exit 1
