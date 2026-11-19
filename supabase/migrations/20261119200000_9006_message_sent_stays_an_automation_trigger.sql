-- manifest: message.sent leaves the fn_event_log_e_registro list again (Berseba 9002, issue #57): upstream's 9212 and 9383 redefined the list from a copy that still had it, which would make every message.sent row be born done and the "Mensagem enviada pela equipe" automation never run
--
-- Berseba fork migration (see BERSEBA.md, rule 8). Forward fix after the
-- v1.118.0 sync: 9212 (conversation.closed) and 9383 (lead.updated) are
-- additive redefinitions of the registry list written upstream, where
-- `message.sent` is still registry (no consumer there). Applied after 9002,
-- each one put `message.sent` back. The body below is the baseline's (the
-- list of 9383 without `message.sent`), so the chain and the baseline end
-- with the same function. Gates: `tests/unit/evento-de-fato-nao-fica-pendente.test.ts`
-- and `tests/unit/apendice-do-baseline-nao-diverge-da-cadeia.test.ts`.
--
-- No backfill: message.sent rows written while the list had it were born
-- `done`; replaying them would fire rules on old messages.
create or replace function public.fn_event_log_e_registro(p_event_type text)
returns boolean
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  select p_event_type = any (array[
    -- IA e agente
    'ai.responded',
    'ai_agent.created',
    'ai_agent.published',
    'ai_agent.run_completed',
    'ai_agent.run_failed',
    'ai_agent.run_started',
    -- agente (harness) — o motor registra quando não há negócio para pendurar
    'agent.activity_unrouted',
    -- canal e conversa
    'channel_session.status_changed',
    'conversation.claimed',
    'conversation.closed',
    'conversation.transferred',
    'whatsapp.chat_id_not_recognized',
    'whatsapp.conversation_mark_failed',
    -- contato, lead, organização e plataforma
    -- ('lead.reopened' saiu na 0534 e 'lead.updated' na 9383: ganharam consumidor)
    'contact.anonymized',
    'contact.created',
    'contact.deleted',
    'contact.updated',
    'crm.activity_write_failed',
    'incident.resolved',
    'lead.bulk_assigned',
    'lead.bulk_deleted',
    'lead.bulk_tagged',
    'lead.risk_backlog_seeded',
    'org.updated',
    'tenant.onboarded',
    'tenant.reactivated',
    'tenant.suspended',
    'user.profile_updated',
    -- mensagem ('message.failed' saiu aqui na 0417: ele ganhou consumidor)
    -- Berseba 9002 (#57): 'message.sent' left the list, it became an automation trigger
    'message.outbound',
    'message.sending',
    -- LGPD
    'lgpd.export_delivered',
    'lgpd.export_generated',
    'lgpd.redact_applied',
    'lgpd.redact_failed'
  ]::text[]);
$$;

-- Mesma ACL de `fn_log_event` (migration 0034): função pura de leitura, útil no
-- SQL editor de uma instalação, e nunca alcançável pela anon key.
revoke all on function public.fn_event_log_e_registro(text) from public, anon;
grant execute on function public.fn_event_log_e_registro(text) to authenticated, service_role;
