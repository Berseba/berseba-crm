#!/usr/bin/env bash
# Berseba (migration 9005): update.sh takes the analytics contract views down
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
drop=$(line 'analytics_views_drop')
baseline=$(line 'if reaplicar_baseline "$PROJECT_DIR/supabase/baseline.sql"')
recreate=$(line 'analytics_views_recreate')
policies=$(line 'E AS REGRAS DE ISOLAMENTO SÃO CONFERIDAS')
check "every anchor was found" test -n "$checkout" -a -n "$sourced" -a -n "$drop" -a -n "$baseline" -a -n "$recreate" -a -n "$policies"
check "_analytics.sh is sourced after the checkout" test "${sourced:-0}" -gt "${checkout:-0}"
check "the drop comes right before the baseline" test "$(( ${baseline:-0} - ${drop:-0} ))" = 1
check "the recreate comes after the baseline and its error report" \
  test "${recreate:-0}" -gt "${baseline:-0}" -a "${recreate:-0}" -lt "${policies:-0}"
check "update.sh calls each step once" \
  test "$(grep -c '^ *analytics_views_drop' "$U")" = 1 -a "$(grep -c '^ *analytics_views_recreate' "$U")" = 1

echo
if [ "$FAILS" -eq 0 ]; then echo "✓ analytics views around the baseline: all checks passed"; exit 0; fi
echo "✗ $FAILS check(s) failed"; exit 1
