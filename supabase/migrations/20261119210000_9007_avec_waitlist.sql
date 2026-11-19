-- manifest: Berseba: the avec salon's waitlist (`avec_waitlist`). One row per client who wants an earlier slot, with the same request the agent searches in avec (service, hair length, professional), the days and start window she can come, the order the team chose, and the offer in progress (one person at a time, held until a deadline). Org-scoped read for members, writes only by the server (service_role). Anonymizing the contact deletes her rows (`trg_avec_waitlist_anonimizado`), and the LGPD export delivers them.
--
-- Berseba fork migration (see BERSEBA.md, rule 8: our numbers sit below 9016).
--
-- Why a table of our own and not upstream's `calendar_waitlist` (module
-- `lista_de_espera`, 9235): upstream's entry points at a CRM service
-- (`calendar_event_types`) and a CRM user, and its slot is a cancelled CRM
-- appointment. The salon's agenda is avec: its services, professionals and
-- appointments live there, and its CRM agenda is empty. The policy is the same
-- as upstream's (one offer at a time, deadline from `settings.lista_de_espera`,
-- a refused slot is never offered again); only the storage speaks avec.
--
-- Idempotent: `create ... if not exists`, `drop ... if exists` + `create`,
-- `create or replace`.

create table if not exists public.avec_waitlist (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  -- `{servico, comprimento, profissional}`: the arguments of `avec_free_slots`.
  pedido jsonb not null,
  data_de date not null,
  data_ate date not null,
  depois_de time,
  ate time,
  -- The day of the visit she already has and wants to move earlier.
  substitui_data date,
  -- Smaller is called first; the team reorders by swapping it.
  ordem double precision not null default extract(epoch from now()),
  status text not null default 'waiting',
  -- The visit offered: opcao_id, day, start, end, professional, helper, labels.
  oferta jsonb,
  -- `day|start|professional` of the offer: the hold and the "refused" memory.
  oferta_chave text,
  oferta_expira_em timestamptz,
  ofertada_em timestamptz,
  recusadas text[] not null default '{}',
  -- What was booked in avec when she said yes.
  resultado jsonb,
  observacoes text,
  created_by_kind text not null default 'user',
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  encerrada_em timestamptz
);

alter table public.avec_waitlist drop constraint if exists avec_waitlist_status_check;
alter table public.avec_waitlist add constraint avec_waitlist_status_check
  check (status in ('waiting', 'offered', 'booked', 'cancelled', 'expired'));

alter table public.avec_waitlist drop constraint if exists avec_waitlist_created_by_kind_check;
alter table public.avec_waitlist add constraint avec_waitlist_created_by_kind_check
  check (created_by_kind in ('user', 'ai'));

alter table public.avec_waitlist drop constraint if exists avec_waitlist_datas_check;
alter table public.avec_waitlist add constraint avec_waitlist_datas_check
  check (data_ate >= data_de and (depois_de is null or ate is null or ate >= depois_de));

alter table public.avec_waitlist drop constraint if exists avec_waitlist_pedido_check;
alter table public.avec_waitlist add constraint avec_waitlist_pedido_check
  check (jsonb_typeof(pedido) = 'object' and pedido ? 'servico');

alter table public.avec_waitlist drop constraint if exists avec_waitlist_oferta_check;
alter table public.avec_waitlist add constraint avec_waitlist_oferta_check
  check (status <> 'offered' or (oferta is not null and oferta_chave is not null and oferta_expira_em is not null));

alter table public.avec_waitlist drop constraint if exists avec_waitlist_observacoes_check;
alter table public.avec_waitlist add constraint avec_waitlist_observacoes_check
  check (observacoes is null or char_length(observacoes) <= 500);

-- The queue, in calling order.
create index if not exists idx_avec_waitlist_fila
  on public.avec_waitlist (organization_id, ordem, created_at)
  where status in ('waiting', 'offered');

-- One live entry per client and service.
create unique index if not exists uniq_avec_waitlist_viva_por_servico
  on public.avec_waitlist (organization_id, contact_id, (pedido->>'servico'))
  where status in ('waiting', 'offered');

-- A slot is held for one person at a time.
create unique index if not exists uniq_avec_waitlist_vaga_segurada
  on public.avec_waitlist (organization_id, oferta_chave)
  where status = 'offered';

-- One offer per client at a time, even with two entries (two services).
create unique index if not exists uniq_avec_waitlist_uma_oferta_por_cliente
  on public.avec_waitlist (organization_id, contact_id)
  where status = 'offered';

create index if not exists idx_avec_waitlist_ofertas_a_vencer
  on public.avec_waitlist (oferta_expira_em)
  where status = 'offered';

create index if not exists idx_avec_waitlist_contato
  on public.avec_waitlist (organization_id, contact_id);

alter table public.avec_waitlist enable row level security;

drop policy if exists tenant_isolation_avec_waitlist_read on public.avec_waitlist;
create policy tenant_isolation_avec_waitlist_read on public.avec_waitlist
  for select
  using (organization_id in (select public.fn_user_org_ids()));

-- No write policy and no write grant for sessions: the API routes and the agent
-- tool write with the service client, after checking the role and the org.
do $grants_avec_waitlist$
begin
  revoke all on table public.avec_waitlist from anon, authenticated, service_role;
  grant select on table public.avec_waitlist to authenticated;
  grant select, insert, update, delete on table public.avec_waitlist to service_role;
end
$grants_avec_waitlist$;

-- The contact belongs to the row's organization. Without this, a row with org
-- A and a contact of B would pass A's RLS.
create or replace function public.fn_avec_waitlist_contato_da_organizacao()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.organization_id is distinct from old.organization_id then
    raise exception using errcode = '23514', message = 'avec_waitlist_organizacao_imutavel';
  end if;
  if (tg_op = 'INSERT' or new.contact_id is distinct from old.contact_id)
     and not exists (select 1 from public.contacts c
                      where c.id = new.contact_id and c.organization_id = new.organization_id) then
    raise exception using errcode = '23503', message = 'avec_waitlist_contato_de_outra_organizacao';
  end if;
  return new;
end;
$$;

revoke all on function public.fn_avec_waitlist_contato_da_organizacao() from public;
revoke execute on function public.fn_avec_waitlist_contato_da_organizacao() from anon, authenticated;

drop trigger if exists trg_avec_waitlist_contato_da_organizacao on public.avec_waitlist;
create trigger trg_avec_waitlist_contato_da_organizacao
  before insert or update on public.avec_waitlist
  for each row execute function public.fn_avec_waitlist_contato_da_organizacao();

-- LGPD: anonymizing the contact deletes her entries (request, dates, the
-- team's note). Same door as `contact_identities` (9419): the flip of
-- `contacts.is_anonymized`, which both anonymization paths go through.
create or replace function public.fn_avec_waitlist_anonimizado()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_anonymized and not coalesce(old.is_anonymized, false) then
    delete from public.avec_waitlist
     where organization_id = new.organization_id
       and contact_id = new.id;
  end if;
  return null;
end;
$$;

revoke all on function public.fn_avec_waitlist_anonimizado() from public;
revoke execute on function public.fn_avec_waitlist_anonimizado() from anon, authenticated;

drop trigger if exists trg_avec_waitlist_anonimizado on public.contacts;
create trigger trg_avec_waitlist_anonimizado
  after update of is_anonymized on public.contacts
  for each row execute function public.fn_avec_waitlist_anonimizado();

comment on table public.avec_waitlist is
  'Berseba (migration 9007): waitlist of the avec salon. One offer at a time, deadline from organizations.settings.lista_de_espera. Written only by the server.';

do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;
