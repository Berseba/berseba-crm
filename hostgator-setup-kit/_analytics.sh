#!/usr/bin/env bash
# Berseba (migration 9005): the analytics contract views around the baseline.
#
# `analytics.v1_contagem_dia` reads crm_leads, crm_lead_activities, messages,
# conversations and event_log. A view pins the type of every column it reads,
# so an upstream `alter column ... type` in the baseline would fail while the
# view exists — and update.sh applies the baseline WITHOUT stopping on errors,
# so that change would be skipped in silence. update.sh therefore:
#
#   analytics_views_drop       before the baseline
#   analytics_views_recreate   after it
#
# Both call functions the baseline defines (`analytics.fn_drop_views()`,
# `analytics.fn_recreate_views()`) and skip when they do not exist yet (the
# first update that brings migration 9005, or a clone without it). Neither
# fails the update: the CRM does not need these views, the platform's collector
# does, and a missing view fails that collector loudly on its own side.
#
# Sourced by update.sh after `_common.sh` (needs `pg_container` and
# `url_do_schema`). Kept in its own file so an upstream sync never conflicts here.

# The SQL, separate from the call, so tests/shell/analytics-views.test.sh can
# read what is sent.
ANALYTICS_DROP_SQL="do \$\$ begin if to_regprocedure('analytics.fn_drop_views()') is not null then perform analytics.fn_drop_views(); end if; end \$\$;"
ANALYTICS_RECREATE_SQL="do \$\$ begin if to_regprocedure('analytics.fn_recreate_views()') is not null then perform analytics.fn_recreate_views(); end if; end \$\$;"

analytics_sql() {
  pg_container postgres:17-alpine psql "$(url_do_schema)" -v ON_ERROR_STOP=1 -qAt -c "$1"
}

analytics_views_drop() {
  if analytics_sql "$ANALYTICS_DROP_SQL" >/dev/null 2>&1; then
    return 0
  fi
  c_ylw "⚠ Não consegui tirar as views de analytics antes do banco (sigo assim mesmo)."
  return 0
}

analytics_views_recreate() {
  if analytics_sql "$ANALYTICS_RECREATE_SQL" >/dev/null 2>&1; then
    return 0
  fi
  c_ylw "⚠ As views de analytics não foram recriadas: o painel de metas da Berseba fica sem os números."
  c_ylw "  Repita só este passo:"
  c_ylw "    psql \"<conexão do banco>\" -c 'select analytics.fn_recreate_views();'"
  return 0
}
