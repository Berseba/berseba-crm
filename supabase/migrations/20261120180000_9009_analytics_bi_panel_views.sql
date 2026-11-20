-- manifest: Berseba analytics contract, BI panel views — analytics.fn_recreate_views() now also builds v1_leads_dia, v1_atendimentos_dia, v1_reunioes_dia, v1_conversas_abertas and v1_tempo_resposta_dia over Berseba's own organization (counts and aggregates only), each readable by analytics_reader only
-- ============================================================================
-- 9009 — More read-only views on the analytics contract, for the Metabase BI
-- panel (Berseba).
--
-- Same rules as 9005 (BERSEBA.md, "Analytics contract"): schema `analytics`,
-- only Berseba's organization (4212479e-2b5a-4949-807e-706b2fce16fe), days in
-- America/Sao_Paulo, counts and aggregates only (no name, phone, title, note
-- or message text), security_barrier views that bypass RLS on purpose (the
-- view is the organization filter; Supabase linter 0010 accepted exception),
-- SELECT for analytics_reader only.
--
-- Number 9009: the next free number below 9016 (BERSEBA.md, golden rule 8).
--
-- The views live in analytics.fn_recreate_views(), redefined here with the
-- 9005 view unchanged plus the five new ones, so the deploy path is the one
-- 9005 set up: update.sh drops every view in `analytics` before the baseline
-- and calls fn_recreate_views() after it. By hand:
--   select analytics.fn_recreate_views();
-- The same text, minus the last statement, is the `analytics BI panel views
-- (migration 9009)` block of supabase/baseline.sql, right after the 9005 block.
--
-- Shared definitions:
--  * WhatsApp conversation: conversations.channel = 'whatsapp', not a group.
--  * Reply from us: an outbound message that left (status sent, delivered or
--    read; not queued, sending or failed), not a reaction or a system
--    message, sent by a person (sent_via crm, user, external_device) or by
--    the AI (sent_via ai). Automations and system messages are not replies.
--  * Message history: the two views over messages read the last 430 days
--    (idx_messages_org_direction_sent) and show the last 400.
--  * Each new view is built in its own exception block: a failure raises a
--    WARNING and never takes v1_contagem_dia down.
--  * Client message: an inbound message that is not a reaction or a system
--    message.
-- ============================================================================

create or replace function analytics.fn_recreate_views()
returns void
language plpgsql
set search_path = ''
as $fn$
begin
  -- v1_contagem_dia: migration 9005, unchanged. See that migration for the
  -- definitions of contas_novas, toques and reunioes.
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

  -- The five BI panel views. Each one is built in its own block: a view that
  -- fails (an upstream column it reads changed) only raises a WARNING and is
  -- left out, and never takes v1_contagem_dia, which the ops collector
  -- depends on, down with it.

  -- v1_leads_dia: new leads per Brasilia day (crm_leads.created_at), split by
  -- origin and plan. crm_leads.source is free text (the leads API and MCP
  -- accept any string), so origem is one of the values the code writes
  -- (lib/channels/origem-do-negocio.ts, lib/leads, lib/prospecting,
  -- lib/campanhas, the importers, the webhooks) and 'outro' for everything
  -- else. plano is 'plano-enterprise' when the lead carries that tag today,
  -- else 'outro'. One row per (dia, origem, plano) with at least one lead.
  begin
    drop view if exists analytics.v1_leads_dia;
    create view analytics.v1_leads_dia
      with (security_barrier = true)
    as
    select (l.created_at at time zone 'America/Sao_Paulo')::date as dia,
           case
             when l.source in (
               'manual', 'whatsapp', 'whatsapp_operador', 'whatsapp_group', 'instagram', 'facebook',
               'telegram', 'social', 'meta_ads', 'campanha', 'prospecting', 'automation', 'webhook',
               'import_csv', 'importacao_planilha', 'inbox_entrada_automatica', 'reactivation',
               'retomada', 'ai_agent'
             ) then l.source
             else 'outro'
           end as origem,
           case when 'plano-enterprise' = any (l.tags) then 'plano-enterprise' else 'outro' end as plano,
           count(*)::int as leads_novos
    from public.crm_leads l
    where l.organization_id = '4212479e-2b5a-4949-807e-706b2fce16fe'::uuid
    group by 1, 2, 3;

    comment on view analytics.v1_leads_dia is
      'Owner: Berseba BI panel (Metabase). Contract v1: per Brasilia day (crm_leads.created_at) of Berseba''s own organization, new leads by origem (crm_leads.source when it is a value the code writes, else outro; free text never leaves) and plano (plano-enterprise when the lead carries that tag now, else outro). Counts only. Columns never change in place; a change ships as v2. Bypasses RLS on purpose (Supabase linter 0010): the view is the organization filter. Migration 9009, BERSEBA.md.';

    revoke all on analytics.v1_leads_dia from public, anon, authenticated, service_role;
    grant select on analytics.v1_leads_dia to analytics_reader;
  exception when others then
    raise warning 'analytics.v1_leads_dia was not rebuilt: % (%)', sqlerrm, sqlstate;
  end;

  -- v1_atendimentos_dia: per Brasilia day, WhatsApp conversations where the
  -- client wrote (conversas), the ones whose first client message is that day
  -- (conversas_novas), the ones that got a reply from us after the day's first
  -- client message, the same day (respondidas), and the ones where at least
  -- one of those replies came from the AI (respondidas_pela_ia). Only the last
  -- 400 days are shown; messages are read 430 days back (the window keeps
  -- idx_messages_org_direction_sent in use), so "first client message" looks
  -- 30 days before the oldest day shown: a client silent for more than 430
  -- days counts as new again.
  begin
    drop view if exists analytics.v1_atendimentos_dia;
    create view analytics.v1_atendimentos_dia
      with (security_barrier = true)
    as
    with msgs as (
      select m.conversation_id,
             m.direction,
             m.sent_via,
             m.sent_at,
             (m.sent_at at time zone 'America/Sao_Paulo')::date as dia
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.organization_id = '4212479e-2b5a-4949-807e-706b2fce16fe'::uuid
        and c.organization_id = '4212479e-2b5a-4949-807e-706b2fce16fe'::uuid
        and m.sent_at >= now() - interval '430 days'
        and c.channel = 'whatsapp'
        and not c.is_group
        and m.type not in ('reaction', 'system')
        and (
          m.direction = 'inbound'
          or (m.status in ('sent', 'delivered', 'read') and m.sent_via in ('crm', 'user', 'external_device', 'ai'))
        )
    ),
    per_conversation_day as (
      select conversation_id,
             dia,
             min(sent_at) filter (where direction = 'inbound') as primeira_do_cliente,
             max(sent_at) filter (where direction = 'outbound') as ultima_nossa,
             max(sent_at) filter (where direction = 'outbound' and sent_via = 'ai') as ultima_da_ia
      from msgs
      group by conversation_id, dia
    ),
    client_days as (
      select p.*,
             min(p.primeira_do_cliente) over (partition by p.conversation_id) as primeira_de_todas
      from per_conversation_day p
      where p.primeira_do_cliente is not null
    )
    select dia,
           count(*)::int as conversas,
           count(*) filter (where primeira_do_cliente = primeira_de_todas)::int as conversas_novas,
           count(*) filter (where ultima_nossa >= primeira_do_cliente)::int as respondidas,
           count(*) filter (where ultima_da_ia >= primeira_do_cliente)::int as respondidas_pela_ia
    from client_days
    where dia >= (now() at time zone 'America/Sao_Paulo')::date - 400
    group by dia;

    comment on view analytics.v1_atendimentos_dia is
      'Owner: Berseba BI panel (Metabase). Contract v1: per Brasilia day, last 400 days, Berseba''s own WhatsApp conversations (no groups) where the client wrote (conversas), first client message within the 430 days read, so a client silent for longer counts as new again (conversas_novas), replied by a person or the AI (status sent, delivered or read) after the day''s first client message, same day (respondidas), and with at least one AI reply (respondidas_pela_ia). Automations are not replies. Counts only. Columns never change in place; a change ships as v2. Bypasses RLS on purpose (Supabase linter 0010). Migration 9009, BERSEBA.md.';

    revoke all on analytics.v1_atendimentos_dia from public, anon, authenticated, service_role;
    grant select on analytics.v1_atendimentos_dia to analytics_reader;
  exception when others then
    raise warning 'analytics.v1_atendimentos_dia was not rebuilt: % (%)', sqlerrm, sqlstate;
  end;

  -- v1_reunioes_dia: per Brasilia day the event was recorded on a lead's
  -- timeline (crm_lead_activities.performed_at), every lead of the
  -- organization (not only plano-enterprise): appointments scheduled,
  -- completed (held), no-show and cancelled. The day is when it was recorded,
  -- not the day of the meeting.
  begin
    drop view if exists analytics.v1_reunioes_dia;
    create view analytics.v1_reunioes_dia
      with (security_barrier = true)
    as
    select (a.performed_at at time zone 'America/Sao_Paulo')::date as dia,
           count(*) filter (where a.type = 'appointment_scheduled')::int as marcadas,
           count(*) filter (where a.type = 'appointment_completed')::int as realizadas,
           count(*) filter (where a.type = 'appointment_no_show')::int as faltas,
           count(*) filter (where a.type = 'appointment_cancelled')::int as canceladas
    from public.crm_lead_activities a
    where a.organization_id = '4212479e-2b5a-4949-807e-706b2fce16fe'::uuid
      and a.type in ('appointment_scheduled', 'appointment_completed', 'appointment_no_show', 'appointment_cancelled')
    group by 1;

    comment on view analytics.v1_reunioes_dia is
      'Owner: Berseba BI panel (Metabase). Contract v1: per Brasilia day the event was recorded on the lead timeline, appointments scheduled (marcadas), held (realizadas), no-show (faltas) and cancelled (canceladas) on every lead of Berseba''s own organization. Counts only. Columns never change in place; a change ships as v2. Bypasses RLS on purpose (Supabase linter 0010). Migration 9009, BERSEBA.md.';

    revoke all on analytics.v1_reunioes_dia from public, anon, authenticated, service_role;
    grant select on analytics.v1_reunioes_dia to analytics_reader;
  exception when others then
    raise warning 'analytics.v1_reunioes_dia was not rebuilt: % (%)', sqlerrm, sqlstate;
  end;

  -- v1_conversas_abertas: always one row, measured at query time. A WhatsApp
  -- conversation (no groups) awaits us when it is not closed, archived or
  -- resolved, and the client's last message is after our last outbound and
  -- after the end of the last service (the Inbox queue's columns: any
  -- outbound, automations included, answers). The wait starts at
  -- conversations.awaiting_since (the oldest unanswered client message), or
  -- last_inbound_at when it is empty.
  begin
    drop view if exists analytics.v1_conversas_abertas;
    create view analytics.v1_conversas_abertas
      with (security_barrier = true)
    as
    with waiting as (
      select coalesce(c.awaiting_since, c.last_inbound_at) as desde
      from public.conversations c
      where c.organization_id = '4212479e-2b5a-4949-807e-706b2fce16fe'::uuid
        and c.channel = 'whatsapp'
        and not c.is_group
        and c.status not in ('closed', 'archived', 'resolved')
        and c.last_inbound_at is not null
        and c.last_inbound_at > coalesce(c.last_outbound_at, '-infinity'::timestamptz)
        and c.last_inbound_at > coalesce(c.service_closed_at, '-infinity'::timestamptz)
    )
    select now() as medido_em,
           count(*)::int as aguardando,
           floor(extract(epoch from now() - min(desde)) / 60)::int as espera_mais_antiga_min,
           count(*) filter (where desde < now() - interval '1 hour')::int as aguardando_mais_de_1h
    from waiting;

    comment on view analytics.v1_conversas_abertas is
      'Owner: Berseba BI panel (Metabase). Contract v1, one row measured now: Berseba''s own open WhatsApp conversations (no groups) whose last message is the client''s (aguardando), the oldest wait in whole minutes from conversations.awaiting_since (espera_mais_antiga_min, null when none) and how many wait more than 1 hour (aguardando_mais_de_1h). Counts only. Columns never change in place; a change ships as v2. Bypasses RLS on purpose (Supabase linter 0010). Migration 9009, BERSEBA.md.';

    revoke all on analytics.v1_conversas_abertas from public, anon, authenticated, service_role;
    grant select on analytics.v1_conversas_abertas to analytics_reader;
  exception when others then
    raise warning 'analytics.v1_conversas_abertas was not rebuilt: % (%)', sqlerrm, sqlstate;
  end;

  -- v1_tempo_resposta_dia: per Brasilia day a wait started, last 400 days
  -- (messages read 430 days back, as in v1_atendimentos_dia). A wait starts
  -- at a client message that is the conversation's first message read or
  -- comes right after a reply from us (later client messages before our
  -- reply belong to the same wait). Its time is until our first reply after
  -- it (status sent, delivered or read), in minutes, calendar time (no
  -- business hours). respostas_medidas counts the waits that got a reply,
  -- sem_resposta the ones that did not (yet).
  begin
    drop view if exists analytics.v1_tempo_resposta_dia;
    create view analytics.v1_tempo_resposta_dia
      with (security_barrier = true)
    as
    with msgs as (
      select m.conversation_id, m.direction, m.sent_at
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.organization_id = '4212479e-2b5a-4949-807e-706b2fce16fe'::uuid
        and c.organization_id = '4212479e-2b5a-4949-807e-706b2fce16fe'::uuid
        and m.sent_at >= now() - interval '430 days'
        and c.channel = 'whatsapp'
        and not c.is_group
        and m.type not in ('reaction', 'system')
        and (
          m.direction = 'inbound'
          or (m.status in ('sent', 'delivered', 'read') and m.sent_via in ('crm', 'user', 'external_device', 'ai'))
        )
    ),
    sequenced as (
      select direction,
             sent_at,
             lag(direction) over w as anterior,
             min(sent_at) filter (where direction = 'outbound')
               over (w rows between 1 following and unbounded following) as resposta
      from msgs
      window w as (partition by conversation_id order by sent_at, direction)
    ),
    waits as (
      select (sent_at at time zone 'America/Sao_Paulo')::date as dia,
             extract(epoch from resposta - sent_at)::double precision / 60 as minutos
      from sequenced
      where direction = 'inbound'
        and anterior is distinct from 'inbound'
    )
    select dia,
           count(minutos)::int as respostas_medidas,
           (count(*) - count(minutos))::int as sem_resposta,
           round((percentile_cont(0.5) within group (order by minutos))::numeric, 1) as mediana_min,
           round((percentile_cont(0.9) within group (order by minutos))::numeric, 1) as p90_min
    from waits
    where dia >= (now() at time zone 'America/Sao_Paulo')::date - 400
    group by dia;

    comment on view analytics.v1_tempo_resposta_dia is
      'Owner: Berseba BI panel (Metabase). Contract v1: per Brasilia day a client wait started, last 400 days, on Berseba''s own WhatsApp conversations (no groups), minutes to our first reply by a person or the AI (status sent, delivered or read): median (mediana_min) and p90 (p90_min), calendar time, over the waits that got a reply (respostas_medidas); sem_resposta counts the ones still unanswered. Automations are not replies. Aggregates only. Columns never change in place; a change ships as v2. Bypasses RLS on purpose (Supabase linter 0010). Migration 9009, BERSEBA.md.';

    revoke all on analytics.v1_tempo_resposta_dia from public, anon, authenticated, service_role;
    grant select on analytics.v1_tempo_resposta_dia to analytics_reader;
  exception when others then
    raise warning 'analytics.v1_tempo_resposta_dia was not rebuilt: % (%)', sqlerrm, sqlstate;
  end;
end;
$fn$;

revoke all on function analytics.fn_recreate_views() from public, anon, authenticated, service_role;

-- The reader: Metabase pools its connections and the ops collector uses the
-- same role, so 2 (9005) is too few. statement_timeout stays 15 s.
alter role analytics_reader connection limit 6;

-- Build the views now. On a self-host install update.sh calls the same
-- function after the baseline.
select analytics.fn_recreate_views();
