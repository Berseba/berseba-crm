-- manifest: Berseba analytics contract — schema analytics (not exposed), view v1_contagem_dia (daily new accounts, touches and meetings of Berseba's own plano-enterprise leads, counts only) rebuilt by analytics.fn_recreate_views(), and the read-only login role analytics_reader (no password here)
-- ============================================================================
-- 9005 — The CRM's analytics contract for the weekly goals (Berseba).
--
-- Spec: Berseba/berseba#245 (ADR 0003, slice 1). The platform's ops collector
-- (`packages/ops`, vendor `crm`) logs in as analytics_reader and reads
-- analytics.v1_contagem_dia into ops_usage_daily; the Metas screen sums the week.
--
-- Number 9005: our own range below 9016, where upstream's 9NNN started, so no
-- upstream sync can take it (BERSEBA.md, golden rule 8).
--
-- The same text, minus the last statement, is the `analytics contract
-- (migration 9005)` block of supabase/baseline.sql. The baseline does not build
-- the view: update.sh does, after the baseline (see step 4).
-- ============================================================================

-- 1. The schema. It is NOT in PostgREST's exposed schemas (Supabase: Settings ›
--    API › Exposed schemas; local: supabase/config.toml [api].schemas), and the
--    API roles get nothing on it, so even listing it there would answer 403.
create schema if not exists analytics;
revoke all on schema analytics from public, anon, authenticated, service_role;
comment on schema analytics is
  'Berseba (migration 9005): read-only contract views for the platform''s ops collector. Not exposed through PostgREST. Views are rebuilt by analytics.fn_recreate_views().';

-- 2. The reader. LOGIN with NO password: until someone sets one by hand in
--    production (`alter role analytics_reader password '...'`), nobody can log
--    in as it. Re-applying never touches a password that was set.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'analytics_reader') then
    create role analytics_reader login connection limit 2;
  end if;
end $$;
-- Re-asserted on every apply. Only LOGIN and the connection limit: naming
-- NOSUPERUSER/NOBYPASSRLS here would need superuser on Supabase, and
-- `create role` already defaults to none of them.
alter role analytics_reader login connection limit 2;
alter role analytics_reader set statement_timeout = '15s';
alter role analytics_reader set search_path = analytics;
grant usage on schema analytics to analytics_reader;
alter default privileges in schema analytics grant select on tables to analytics_reader;
alter default privileges in schema analytics revoke execute on functions from public;

-- 3. Nothing in `public`. These revokes are explicit for the role. What it
--    still gets through the PUBLIC pseudo-role cannot be revoked per role in
--    Postgres: USAGE on the schema and EXECUTE on functions granted to PUBLIC.
--    Measured in production on 2026-11-12: no table or view in `public` is
--    granted to PUBLIC, and no SECURITY DEFINER function in `public` is
--    executable by PUBLIC (upstream's rule, fenced by
--    tests/invariants/hardening-definer-varredura.test.ts). So a function the
--    role can call runs as the role and reads nothing.
--    tests/invariants/analytics-contract.test.ts measures both facts.
revoke all on schema public from analytics_reader;
revoke all on all tables in schema public from analytics_reader;
revoke all on all sequences in schema public from analytics_reader;
revoke all on all functions in schema public from analytics_reader;

-- 4. The views live in a function so the deploy can drop and rebuild them
--    around the baseline (hostgator-setup-kit/update.sh): a view pins the type
--    of every column it reads, and an upstream `alter column ... type` on
--    crm_leads, crm_lead_activities, messages, conversations or event_log
--    would otherwise fail the update. The baseline defines these functions and
--    does NOT call them; update.sh does, after the whole baseline.
create or replace function analytics.fn_drop_views()
returns void
language plpgsql
set search_path = ''
as $fn$
declare
  v record;
begin
  for v in
    select c.oid::pg_catalog.regclass as rel
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'analytics' and c.relkind = 'v'
  loop
    execute pg_catalog.format('drop view if exists %s cascade', v.rel);
  end loop;
end;
$fn$;

-- v1_contagem_dia — one row per Brasília day with activity on Berseba's own
-- leads tagged `plano-enterprise` (organization 4212479e-2b5a-4949-807e-706b2fce16fe,
-- the one with the "Comercial" funnel; confirmed read-only in production on
-- 2026-11-12). Counts only: no name, phone, note or message text leaves.
--
--  contas_novas  the day the lead got the tag, counted once per lead (the
--                first time). Evidence, earliest wins: `lead_edited` activities
--                whose payload.added_tags has it (written by the agent path
--                only), and `lead.tag_added` events in event_log (written by
--                the lead PATCH, bulk, MCP and automations; event_log is never
--                pruned). A lead with no evidence was created with the tag (the
--                create path writes neither), so its created_at is the day.
--  toques        distinct (lead, day, channel) over `touch` activities (their
--                payload.channel) and outbound WhatsApp messages to the lead's
--                contact (not failed, not a group; any sender: team, phone,
--                automation, AI). So a manual WhatsApp touch on a day that
--                already had a WhatsApp message is not counted twice, and a
--                conversation counts once per day, not per message.
--  reunioes      `appointment_scheduled` activities on those leads.
--
-- A lead counts while it carries the tag: removing the tag removes its history
-- from the view. Days with no activity are absent.
--
-- It reads tenant tables as its owner and so bypasses RLS: the Supabase linter
-- reports this as 0010 (security_definer_view). That is intended — the view IS
-- the organization filter, and only analytics_reader can read it. Recorded in
-- BERSEBA.md. security_barrier keeps a caller's own predicates from being
-- pushed below that filter.
create or replace function analytics.fn_recreate_views()
returns void
language plpgsql
set search_path = ''
as $fn$
begin
  drop view if exists analytics.v1_contagem_dia;
  create view analytics.v1_contagem_dia
    with (security_barrier = true)
  as
  with enterprise_leads as (
    select l.id, l.contact_id, l.created_at
    from public.crm_leads l
    where l.organization_id = '4212479e-2b5a-4949-807e-706b2fce16fe'::uuid
      and 'plano-enterprise' = any (l.tags)
  ),
  tag_added as (
    select a.lead_id, a.performed_at as tagged_at
    from public.crm_lead_activities a
    join enterprise_leads el on el.id = a.lead_id
    where a.organization_id = '4212479e-2b5a-4949-807e-706b2fce16fe'::uuid
      and a.type = 'lead_edited'
      and a.payload -> 'added_tags' ? 'plano-enterprise'
    union all
    select e.entity_id, e.created_at
    from public.event_log e
    join enterprise_leads el on el.id = e.entity_id
    where e.organization_id = '4212479e-2b5a-4949-807e-706b2fce16fe'::uuid
      and e.event_type = 'lead.tag_added'
      and e.payload -> 'added_tags' ? 'plano-enterprise'
  ),
  new_accounts as (
    select el.id, coalesce(min(t.tagged_at), el.created_at) as tagged_at
    from enterprise_leads el
    left join tag_added t on t.lead_id = el.id
    group by el.id, el.created_at
  ),
  touches as (
    select a.lead_id,
           (a.performed_at at time zone 'America/Sao_Paulo')::date as dia,
           a.payload ->> 'channel' as channel
    from public.crm_lead_activities a
    join enterprise_leads el on el.id = a.lead_id
    where a.organization_id = '4212479e-2b5a-4949-807e-706b2fce16fe'::uuid
      and a.type = 'touch'
    union
    select el.id,
           (coalesce(m.sent_at, m.created_at) at time zone 'America/Sao_Paulo')::date,
           'whatsapp'
    from public.messages m
    join public.conversations c on c.id = m.conversation_id
    join enterprise_leads el on el.contact_id = c.contact_id
    where m.organization_id = '4212479e-2b5a-4949-807e-706b2fce16fe'::uuid
      and c.organization_id = '4212479e-2b5a-4949-807e-706b2fce16fe'::uuid
      and m.direction = 'outbound'
      and m.status is distinct from 'failed'
      and c.channel = 'whatsapp'
      and not c.is_group
  ),
  meetings as (
    select (a.performed_at at time zone 'America/Sao_Paulo')::date as dia
    from public.crm_lead_activities a
    join enterprise_leads el on el.id = a.lead_id
    where a.organization_id = '4212479e-2b5a-4949-807e-706b2fce16fe'::uuid
      and a.type = 'appointment_scheduled'
  ),
  per_day as (
    select (tagged_at at time zone 'America/Sao_Paulo')::date as dia,
           1 as contas_novas, 0 as toques, 0 as reunioes
    from new_accounts
    union all
    select dia, 0, 1, 0 from touches
    union all
    select dia, 0, 0, 1 from meetings
  )
  select dia,
         sum(contas_novas)::int as contas_novas,
         sum(toques)::int as toques,
         sum(reunioes)::int as reunioes
  from per_day
  group by dia;

  comment on view analytics.v1_contagem_dia is
    'Owner: Samuel (comercial). Contract v1, read by the platform ops collector (vendor crm): per Brasilia day, new plano-enterprise accounts, touches and meetings of Berseba''s own organization. Columns never change in place; a change ships as v2. Bypasses RLS on purpose (Supabase linter 0010): the view is the organization filter. Migration 9005, BERSEBA.md.';

  revoke all on analytics.v1_contagem_dia from public, anon, authenticated, service_role;
  grant select on analytics.v1_contagem_dia to analytics_reader;
end;
$fn$;

revoke all on function analytics.fn_drop_views() from public, anon, authenticated, service_role;
revoke all on function analytics.fn_recreate_views() from public, anon, authenticated, service_role;

-- 5. Build the views now. In the chain this migration is the last word on
--    these tables; on a self-host install update.sh calls the same function
--    after the baseline.
select analytics.fn_recreate_views();
