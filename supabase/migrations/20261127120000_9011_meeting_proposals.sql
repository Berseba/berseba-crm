-- manifest: Berseba meeting proposals: a client message that asks for or confirms a meeting becomes a proposal the partner books in one click (server-only)
-- Berseba (migration 9011): meeting proposals (#171, slice 3).
--
-- A cron reads the recent inbound e-mails (gmail_messages, 9010) and 1:1 WhatsApp messages of
-- the organizations in MEETING_DETECTION_ORG_IDS, keeps the ones that talk about meeting, and
-- asks the organization's model whether the client asks for a meeting or confirms a time. Each
-- message the model read gets one row here (`nenhuma` when it was neither, with no text kept),
-- so no message is classified twice. A proposal is booked only when a partner clicks "Criar na
-- agenda": the CRM agenda writes it to the partner's Google Calendar (upstream's push cron).
--
-- SERVER-ONLY: RLS on with no policy, nothing granted to anon/authenticated.

create table if not exists public.meeting_proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- `email`: gmail_messages.id; `whatsapp`: messages.id.
  source text not null,
  source_id uuid not null,
  contact_id uuid references public.contacts(id) on delete cascade,
  -- The partner whose mailbox got the e-mail, or who holds the conversation; the clicker books.
  owner_user_id uuid references auth.users(id) on delete set null,
  intent text not null,
  starts_at timestamptz,
  duration_minutes integer,
  title text,
  excerpt text,
  status text not null default 'proposta',
  appointment_id uuid references public.calendar_appointments(id) on delete set null,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.meeting_proposals drop constraint if exists meeting_proposals_source_check;
alter table public.meeting_proposals add constraint meeting_proposals_source_check
  check (source in ('email', 'whatsapp'));

alter table public.meeting_proposals drop constraint if exists meeting_proposals_intent_check;
alter table public.meeting_proposals add constraint meeting_proposals_intent_check
  check (intent in ('pede', 'confirma', 'nenhuma'));

alter table public.meeting_proposals drop constraint if exists meeting_proposals_status_check;
alter table public.meeting_proposals add constraint meeting_proposals_status_check
  check (status in ('proposta', 'criada', 'descartada', 'nenhuma'));

-- A message the model found nothing in keeps no text.
alter table public.meeting_proposals drop constraint if exists meeting_proposals_nenhuma_sem_texto_check;
alter table public.meeting_proposals add constraint meeting_proposals_nenhuma_sem_texto_check
  check (intent <> 'nenhuma' or (status = 'nenhuma' and title is null and excerpt is null and starts_at is null));

alter table public.meeting_proposals drop constraint if exists meeting_proposals_textos_check;
alter table public.meeting_proposals add constraint meeting_proposals_textos_check
  check ((title is null or char_length(title) <= 200) and (excerpt is null or char_length(excerpt) <= 500)
         and (duration_minutes is null or duration_minutes between 5 and 480));

create unique index if not exists uniq_meeting_proposals_origem
  on public.meeting_proposals (organization_id, source, source_id);

create index if not exists idx_meeting_proposals_abertas
  on public.meeting_proposals (organization_id, created_at desc)
  where status = 'proposta';

create index if not exists idx_meeting_proposals_contato
  on public.meeting_proposals (organization_id, contact_id)
  where contact_id is not null;

alter table public.meeting_proposals enable row level security;

do $grants_meeting_proposals$
begin
  revoke all on table public.meeting_proposals from anon, authenticated, service_role;
  grant select, insert, update, delete on table public.meeting_proposals to service_role;
end
$grants_meeting_proposals$;

-- The proposal's contact belongs to the proposal's organization.
create or replace function public.fn_meeting_proposals_contato_da_organizacao()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.organization_id is distinct from old.organization_id then
    raise exception using errcode = '23514', message = 'meeting_proposals_organizacao_imutavel';
  end if;
  if new.contact_id is not null
     and (tg_op = 'INSERT' or new.contact_id is distinct from old.contact_id)
     and not exists (select 1 from public.contacts c
                      where c.id = new.contact_id and c.organization_id = new.organization_id) then
    raise exception using errcode = '23503', message = 'meeting_proposals_contato_de_outra_organizacao';
  end if;
  return new;
end;
$$;

revoke all on function public.fn_meeting_proposals_contato_da_organizacao() from public;
revoke execute on function public.fn_meeting_proposals_contato_da_organizacao() from anon, authenticated;

drop trigger if exists trg_meeting_proposals_contato_da_organizacao on public.meeting_proposals;
create trigger trg_meeting_proposals_contato_da_organizacao
  before insert or update on public.meeting_proposals
  for each row execute function public.fn_meeting_proposals_contato_da_organizacao();

-- LGPD: anonymizing the contact deletes their proposals (title, excerpt). Same door as 9007/9010.
create or replace function public.fn_meeting_proposals_anonimizado()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_anonymized and not coalesce(old.is_anonymized, false) then
    delete from public.meeting_proposals
     where organization_id = new.organization_id
       and contact_id = new.id;
  end if;
  return null;
end;
$$;

revoke all on function public.fn_meeting_proposals_anonimizado() from public;
revoke execute on function public.fn_meeting_proposals_anonimizado() from anon, authenticated;

drop trigger if exists trg_meeting_proposals_anonimizado on public.contacts;
create trigger trg_meeting_proposals_anonimizado
  after update of is_anonymized on public.contacts
  for each row execute function public.fn_meeting_proposals_anonimizado();

comment on table public.meeting_proposals is
  'Berseba (migration 9011): a client message (e-mail or WhatsApp) the model read for a meeting; `proposta` waits for a partner to book or dismiss it. Server-only. Deleted when the contact is anonymized.';

do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;
