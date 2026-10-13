-- manifest: Assisted-mode drafts carry the catalog product the agent picked (ai_reply_drafts.product_code), and an approved reply may be recorded as an image whose caption is the approved text
-- ============================================================================
-- 9001 — An Assisted-mode draft can carry a product photo (Berseba).
--
-- In autonomous mode `send_message({ body, produto_codigo })` sends the product's
-- catalog photo with the text as its caption. In Assisted mode the draft is
-- built in preview, and the code was dropped: the attendant approved text only.
--
-- 1. `ai_reply_drafts.product_code` — the `catalog_products.codigo` the agent
--    picked, validated against the active catalog when the draft is generated.
--    Written only by the server (service role), never by the attendant: the
--    approval RPC (`fn_reply_action`) does not touch it. RLS is unchanged: the
--    column lives in a table whose only policy for `authenticated` is
--    `tenant_isolation_ai_reply_drafts_all` (select, same organization, and a
--    conversation the user can see), and `authenticated` has no write grant.
--    The value is not personal data, so `fn_reply_redact` leaves it alone.
--
-- 2. `fn_reply_record_receipt` — the receipt only recognised a `text` message.
--    A draft with a product is sent as ONE image message whose caption is the
--    approved body (same `seq = 1`, same body check), so the receipt now also
--    recognises `type = 'image'`, and only when the draft carries a product.
--    Everything else is the 0267 body, unchanged.
--
-- Numbering: 9xxx is Berseba's range. Upstream (DeskcommCRM) numbers its own
-- migrations sequentially from 0001 and is far below 9000, so the weekly sync
-- cannot collide on the number (`manifest-x-migrations` refuses a repeated one).
-- ============================================================================

alter table public.ai_reply_drafts add column if not exists product_code text;

comment on column public.ai_reply_drafts.product_code is
  'catalog_products.codigo the agent attached in Assisted mode (migration 9001). The approved reply sends that product''s cover photo with the approved body as its caption. Server-written only.';

create or replace function public.fn_reply_record_receipt(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz,p_message uuid,p_external text,p_echo_ids text[] default '{}')
returns jsonb language plpgsql security definer set search_path=public as $$
declare contact uuid;d public.ai_reply_drafts;m public.messages;
begin
 select contact_id into contact from public.job_queue where organization_id=p_org and id=p_job;
 if contact is null then return null;end if;
 perform public.fn_service_lock(p_org,contact);
 perform 1 from public.contacts where organization_id=p_org and id=contact and not is_anonymized for share;
 if not found then return null;end if;
 select * into d from public.ai_reply_drafts where organization_id=p_org and send_job_id=p_job;
 if not found then return null;end if;
 perform 1 from public.conversations where organization_id=p_org and id=d.conversation_id and contact_id=contact for no key update;
 if not found then return null;end if;
 perform 1 from public.job_queue where organization_id=p_org and id=p_job for update;
 perform 1 from public.ai_reply_drafts where organization_id=p_org and id=d.id for update;
 if public.fn_reply_receipt_policy(p_org,p_job,p_worker,p_acquired_at)->>'current'<>'true' then return null;end if;
 -- 9001: a draft with a product goes out as one image whose caption is the approved body.
 select * into m from public.messages where organization_id=p_org and id=p_message and conversation_id=d.conversation_id and contact_id=d.contact_id and channel_session_id=d.channel_session_id and direction='outbound' and (type='text' or (type='image' and d.product_code is not null)) and body=d.approved_body and exists(select 1 from public.send_ledger l where l.organization_id=p_org and l.job_id=p_job and l.seq=1 and l.id::text=messages.metadata->>'idempotency_key') for update;
 if not found then return null;end if;
 delete from public.messages where organization_id=p_org and conversation_id=d.conversation_id and sent_via='external_device' and external_id=any(p_echo_ids) and id<>p_message;
 update public.messages set status='sent',external_id=p_external,ack=0 where organization_id=p_org and id=p_message returning * into m;
 update public.send_ledger set status='accepted',crm_message_id=p_message,updated_at=now(),last_error=null where organization_id=p_org and job_id=p_job and seq=1 and id::text=m.metadata->>'idempotency_key';
 -- A resposta aprovada é uma SAÍDA: responde tudo até aqui, e a régua da Fila
 -- (issue #990, migration 0267) volta ao `last_inbound_at` — "não há mensagem do
 -- cliente sem resposta". Sem esta coluna o valor antigo ficaria congelado e a
 -- conversa continuaria contando a espera que esta resposta acabou de encerrar.
 update public.conversations set last_outbound_at=now(),last_message_at=now(),last_message_preview=left(d.approved_body,280),unread_count_for_assignee=0,awaiting_since=last_inbound_at where organization_id=p_org and id=d.conversation_id;
 update public.contacts set last_activity_at=now() where organization_id=p_org and id=contact;
 return to_jsonb(m);
end;$$;
revoke all on function public.fn_reply_record_receipt(uuid,uuid,text,timestamptz,uuid,text,text[]) from public,anon,authenticated;
grant execute on function public.fn_reply_record_receipt(uuid,uuid,text,timestamptz,uuid,text,text[]) to service_role;
