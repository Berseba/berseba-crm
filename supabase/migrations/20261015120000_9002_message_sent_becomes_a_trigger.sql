-- manifest: message.sent leaves the fn_event_log_e_registro list (it gained a consumer: the message.sent automation trigger, issue #57), so its rows are born pending and the drain runs the rules
--
-- Berseba fork migration (9NNN range, see BERSEBA.md): upstream numbers its
-- migrations sequentially and is in the 05xx/06xx range; a fork number in that
-- range would collide on the next sync.
--
-- Why. Same defusing as upstream's 0417 (message.failed) and 0534
-- (lead.reopened), for another type. Upstream's 0239 put `message.sent` in the
-- REGISTRY list: with no consumer, the row was born `done` so it would not look
-- like a stuck queue (#753). Measured in production on 2026-10-15: every
-- `message.sent` row of the last 3 days was `done`.
--
-- Issue #57 makes it an automation trigger: `automationRulesHandler` subscribes
-- to it because it entered `ENTIDADE_ESPERADA_POR_GATILHO`. Without this
-- redefinition `fn_event_log_marca_registro` (BEFORE INSERT) would turn
-- `pending` into `done`, the drain (`status='pending'` AND
-- `event_type in (handlers)`) would never select it, and a rule "Mensagem
-- enviada pela equipe" would be saved and never run.
--
-- Nothing else changes: the list is 0534's without this type. `message.outbound`
-- and `message.sending` stay registry (no consumer).
--
-- Sync hazard: any later upstream redefinition of this function that still
-- lists 'message.sent' silently undoes this. The gate is
-- `tests/unit/evento-de-fato-nao-fica-pendente.test.ts` ("a consumed type in
-- the registry list" fails) — keep it green after every sync.
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
    'conversation.transferred',
    'whatsapp.chat_id_not_recognized',
    'whatsapp.conversation_mark_failed',
    -- contato, lead, organização e plataforma ('lead.reopened' saiu na 0534)
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
    'lead.updated',
    'org.updated',
    'tenant.onboarded',
    'tenant.reactivated',
    'tenant.suspended',
    'user.profile_updated',
    -- mensagem ('message.failed' SAIU aqui na 0417: ele tem consumidor)
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

-- Same ACL as 0239/0417/0534 (create or replace keeps the grants; repeating
-- them keeps this file self-contained).
revoke all on function public.fn_event_log_e_registro(text) from public, anon;
grant execute on function public.fn_event_log_e_registro(text) to authenticated, service_role;

-- No backfill, on purpose (same reason as 0417): old `message.sent` rows were
-- born `done` as registry. Turning them back into `pending` would make a rule
-- run today on a message sent weeks ago.
