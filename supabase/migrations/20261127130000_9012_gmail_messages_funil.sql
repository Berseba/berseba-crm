-- manifest: Berseba e-mail to funnel: gmail_messages.funil_em marks each e-mail already taken to the contact and the deal timeline
-- Berseba (migration 9012): e-mail reaches the contact and the funnel (#171, slice 4).
--
-- After each Gmail read, `levarEmailsAoFunil` takes every stored e-mail once: a person who wrote
-- in becomes a contact, gets a deal in the entry funnel when they have none open, and the e-mail
-- goes on the deal's timeline. `funil_em` says it was done (or that there was nothing to do), so
-- no e-mail is taken twice. Additive: a nullable column and a partial index.

alter table public.gmail_messages
  add column if not exists funil_em timestamptz;

create index if not exists idx_gmail_messages_sem_funil
  on public.gmail_messages (organization_id, sent_at)
  where funil_em is null;

comment on column public.gmail_messages.funil_em is
  'Berseba (migration 9012): when this e-mail was taken to the contact and the deal timeline; null = not yet.';
