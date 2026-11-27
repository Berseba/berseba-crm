-- manifest: Berseba e-mail to funnel: gmail_messages.funil_em marks each e-mail already taken to the contact and the deal timeline
-- Berseba (migration 9012): e-mail reaches the contact and the funnel (#171, slice 4).
--
-- After each Gmail read, `levarEmailsAoFunil` takes every stored e-mail once: a person who wrote
-- in becomes a contact, gets a deal in the entry funnel when they have none open, and the e-mail
-- goes on the deal's timeline. `funil_em` says it was decided (done, or nothing to do), so no
-- e-mail is taken twice; `funil_tentativas` counts failed writes (given up after 3). Additive.

alter table public.gmail_messages
  add column if not exists funil_em timestamptz,
  add column if not exists funil_tentativas integer not null default 0;

create index if not exists idx_gmail_messages_sem_funil
  on public.gmail_messages (organization_id, sent_at)
  where funil_em is null;

comment on column public.gmail_messages.funil_em is
  'Berseba (migration 9012): when this e-mail was taken to the contact and the deal timeline; null = not yet.';
comment on column public.gmail_messages.funil_tentativas is
  'Berseba (migration 9012): failed attempts to take this e-mail to the funnel; after 3 it is given up (logged).';
