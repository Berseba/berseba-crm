-- Berseba (migration 9010): Gmail intake, read-only.
--
-- The partners of the organizations listed in GMAIL_INTAKE_ORG_IDS connect their own Gmail
-- (scope gmail.readonly, accounts listed in GMAIL_INTAKE_ACCOUNTS only). A cron reads new
-- e-mails every 5 minutes and stores them here, linked to the contact whose e-mail matches the
-- counterpart. Nothing is ever sent from here.
--
-- Both tables are SERVER-ONLY: RLS on with no policy, nothing granted to anon/authenticated.
-- The screen (`/app/emails`) reads them through the service role after checking the session's
-- role. Tokens are `fn_encrypt_oauth` ciphertext, like `calendar_connections`.

create table if not exists public.gmail_mailboxes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  account_email text not null,
  oauth_access_token_encrypted bytea,
  oauth_refresh_token_encrypted bytea,
  token_expires_at timestamptz,
  scopes text[] not null default array[]::text[],
  status text not null default 'healthy',
  last_sync_at timestamptz,
  last_sync_error text,
  -- Newest `internalDate` already read; the next run asks Gmail for mail after it (minus 1 h).
  synced_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.gmail_mailboxes drop constraint if exists gmail_mailboxes_status_check;
alter table public.gmail_mailboxes add constraint gmail_mailboxes_status_check
  check (status in ('healthy', 'token_expired', 'scope_missing', 'disconnected', 'error'));

create unique index if not exists uniq_gmail_mailboxes_pessoa
  on public.gmail_mailboxes (organization_id, user_id);

create table if not exists public.gmail_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  mailbox_id uuid not null references public.gmail_mailboxes(id) on delete cascade,
  gmail_message_id text not null,
  gmail_thread_id text not null,
  direction text not null,
  from_email text not null,
  from_name text,
  to_emails text[] not null default array[]::text[],
  cc_emails text[] not null default array[]::text[],
  subject text,
  snippet text,
  body_text text,
  has_attachments boolean not null default false,
  -- Newsletter, notification, auto-reply: List-Unsubscribe, Precedence bulk, Auto-Submitted,
  -- a no-reply sender. Kept, never a reply owed.
  is_automated boolean not null default false,
  sent_at timestamptz not null,
  -- The address outside the mailbox's domain this message is about (the sender of an inbound,
  -- the first outside recipient of an outbound).
  counterpart_email text,
  contact_id uuid references public.contacts(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.gmail_messages drop constraint if exists gmail_messages_direction_check;
alter table public.gmail_messages add constraint gmail_messages_direction_check
  check (direction in ('inbound', 'outbound'));

alter table public.gmail_messages drop constraint if exists gmail_messages_body_check;
alter table public.gmail_messages add constraint gmail_messages_body_check
  check (body_text is null or char_length(body_text) <= 20000);

create unique index if not exists uniq_gmail_messages_por_caixa
  on public.gmail_messages (mailbox_id, gmail_message_id);

create index if not exists idx_gmail_messages_recentes
  on public.gmail_messages (organization_id, sent_at desc);

create index if not exists idx_gmail_messages_contato
  on public.gmail_messages (organization_id, contact_id)
  where contact_id is not null;

create index if not exists idx_gmail_messages_sem_contato
  on public.gmail_messages (organization_id, counterpart_email)
  where contact_id is null and counterpart_email is not null;

alter table public.gmail_mailboxes enable row level security;
alter table public.gmail_messages enable row level security;

do $grants_gmail_intake$
begin
  revoke all on table public.gmail_mailboxes from anon, authenticated, service_role;
  revoke all on table public.gmail_messages from anon, authenticated, service_role;
  grant select, insert, update, delete on table public.gmail_mailboxes to service_role;
  grant select, insert, update, delete on table public.gmail_messages to service_role;
end
$grants_gmail_intake$;

-- The message's contact belongs to the message's organization.
create or replace function public.fn_gmail_messages_contato_da_organizacao()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.organization_id is distinct from old.organization_id then
    raise exception using errcode = '23514', message = 'gmail_messages_organizacao_imutavel';
  end if;
  if new.contact_id is not null
     and (tg_op = 'INSERT' or new.contact_id is distinct from old.contact_id)
     and not exists (select 1 from public.contacts c
                      where c.id = new.contact_id and c.organization_id = new.organization_id) then
    raise exception using errcode = '23503', message = 'gmail_messages_contato_de_outra_organizacao';
  end if;
  return new;
end;
$$;

revoke all on function public.fn_gmail_messages_contato_da_organizacao() from public;
revoke execute on function public.fn_gmail_messages_contato_da_organizacao() from anon, authenticated;

drop trigger if exists trg_gmail_messages_contato_da_organizacao on public.gmail_messages;
create trigger trg_gmail_messages_contato_da_organizacao
  before insert or update on public.gmail_messages
  for each row execute function public.fn_gmail_messages_contato_da_organizacao();

-- LGPD: anonymizing the contact deletes the e-mails linked to them. Same door as
-- `avec_waitlist` (9007) and `contact_identities` (9419): the flip of `contacts.is_anonymized`.
create or replace function public.fn_gmail_messages_anonimizado()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_anonymized and not coalesce(old.is_anonymized, false) then
    delete from public.gmail_messages
     where organization_id = new.organization_id
       and (contact_id = new.id
            or (old.email is not null and counterpart_email = lower(trim(old.email))));
  end if;
  return null;
end;
$$;

revoke all on function public.fn_gmail_messages_anonimizado() from public;
revoke execute on function public.fn_gmail_messages_anonimizado() from anon, authenticated;

drop trigger if exists trg_gmail_messages_anonimizado on public.contacts;
create trigger trg_gmail_messages_anonimizado
  after update of is_anonymized on public.contacts
  for each row execute function public.fn_gmail_messages_anonimizado();

comment on table public.gmail_mailboxes is
  'Berseba (migration 9010): a partner''s Gmail connected read-only (gmail.readonly). One per person per organization. Server-only; tokens ciphered by fn_encrypt_oauth.';
comment on table public.gmail_messages is
  'Berseba (migration 9010): e-mails read from a connected Gmail, linked to the contact by the counterpart address. Server-only. Deleted when the contact is anonymized.';

do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;
