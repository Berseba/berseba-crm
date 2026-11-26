-- 9448 — Berseba: trocar um modelo de IA por outro em tudo, numa chamada só.
--
-- Matheus, 26 Nov 2026: "o ideal é ir sempre para o modelo de menor custo e o que mais entrega, e
-- precisa ser fácil essa troca". Em 25 Nov a saída do gpt-5.6-luna levou várias consultas à mão;
-- esta função faz o mesmo numa linha:
--
--   select * from public.berseba_trocar_modelo('gpt-5.6-luna', 'gpt-6-luna');
--
-- O que ela faz, numa transação:
--   1. recusa se o modelo novo não está no catálogo ou está aposentado;
--   2. troca o padrão de cada organização (organizations.settings->'llm'->>'default_model');
--   3. troca as ligações por função (ai_purpose_bindings.model_id);
--   4. para cada agente publicado no modelo antigo, copia a versão publicada com o modelo novo e
--      publica pela fn_publish_ai_agent_version (a versão anterior fica e pode ser republicada);
--   5. tira o modelo antigo da lista das chaves (ai_provider_credentials.models_available);
--   6. põe o modelo antigo em berseba_modelos_aposentados (9447) e o aposenta no catálogo com todas
--      as variantes, o que faz a publicação de um agente nele falhar e o cron não o traz de volta.
-- Devolve uma linha por mudança. Rodada de novo, não muda nada. Só service_role e postgres executam.

-- Aplicada em produção em 26 Nov 2026 pelo MCP do Supabase.

create or replace function public.berseba_trocar_modelo(p_de text, p_para text)
returns table (tipo text, alvo text, detalhe text)
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  r record;
  v_novo uuid;
  v_numero integer;
begin
  if coalesce(btrim(p_de), '') = '' or coalesce(btrim(p_para), '') = '' or p_de = p_para then
    raise exception 'modelos_invalidos' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.ai_models m where m.model_id = p_para and m.deprecated_at is null
  ) then
    raise exception 'modelo_novo_fora_do_catalogo: %', p_para using errcode = 'P0001';
  end if;
  if public.berseba_modelo_aposentado(p_para) then
    raise exception 'modelo_novo_aposentado: %', p_para using errcode = 'P0001';
  end if;
  if regexp_replace(regexp_replace(p_para, '^[a-z0-9-]+/', ''), ':.*$', '')
     like regexp_replace(p_de, '^[a-z0-9-]+/', '') || '-%' then
    raise exception 'modelo_novo_e_variante_do_antigo: %', p_para using errcode = 'P0001';
  end if;

  for r in
    update public.organizations o
       set settings = jsonb_set(o.settings, '{llm,default_model}', to_jsonb(p_para), true)
     where o.settings->'llm'->>'default_model' = p_de
    returning o.display_name
  loop
    tipo := 'padrao_da_organizacao'; alvo := r.display_name; detalhe := p_de || ' -> ' || p_para;
    return next;
  end loop;

  for r in
    update public.ai_purpose_bindings b set model_id = p_para
     where b.model_id = p_de
    returning b.organization_id, b.purpose
  loop
    tipo := 'ligacao_por_funcao'; alvo := r.purpose || ' (' || r.organization_id || ')';
    detalhe := p_de || ' -> ' || p_para;
    return next;
  end loop;

  for r in
    select a.id as agente, a.organization_id as org, a.name as nome, v.*
      from public.ai_agents a
      join public.ai_agent_versions v on v.id = a.published_version_id
     where v.model = p_de and a.archived_at is null
  loop
    v_novo := gen_random_uuid();
    select coalesce(max(x.version_number), 0) + 1 into v_numero
      from public.ai_agent_versions x where x.agent_id = r.agente;
    insert into public.ai_agent_versions (
      id, organization_id, agent_id, version_number, status, created_by,
      system_prompt, provider, model, credential_id, tool_ids, trigger_config, channel_session_id,
      max_steps, token_budget, cost_budget_cents, history_message_window, history_token_window,
      handoff_keywords, handoff_tool_enabled, followup, multimodal_input, video_frames_enabled,
      split_messages, split_max_chars, cases_enabled, operator_enabled, operator_model, operator_tool_ids,
      pipeline_ids, knowledge_source_ids, proposal_ai_draft_enabled, inbound_debounce_ms,
      handoff_legal_enabled, voz_enabled, voz_quando, reply_min_interval_ms, skill_names,
      image_vision_enabled, reserve_provider, reserve_model)
    values (
      v_novo, r.org, r.agente, v_numero, 'draft', r.created_by,
      r.system_prompt, r.provider, p_para, r.credential_id, r.tool_ids, r.trigger_config, r.channel_session_id,
      r.max_steps, r.token_budget, r.cost_budget_cents, r.history_message_window, r.history_token_window,
      r.handoff_keywords, r.handoff_tool_enabled, r.followup, r.multimodal_input, r.video_frames_enabled,
      r.split_messages, r.split_max_chars, r.cases_enabled, r.operator_enabled,
      case when r.operator_model = p_de then p_para else r.operator_model end, r.operator_tool_ids,
      r.pipeline_ids, r.knowledge_source_ids, r.proposal_ai_draft_enabled, r.inbound_debounce_ms,
      r.handoff_legal_enabled, r.voz_enabled, r.voz_quando, r.reply_min_interval_ms, r.skill_names,
      r.image_vision_enabled, r.reserve_provider,
      case when r.reserve_model = p_de then p_para else r.reserve_model end);
    perform 1 from public.fn_publish_ai_agent_version(r.org, r.agente, v_novo, r.credential_id is null, null);
    tipo := 'agente_republicado'; alvo := r.nome;
    detalhe := 'versao ' || v_numero || ' em ' || p_para || ' (anterior ' || r.id || ')';
    return next;
  end loop;

  for r in
    update public.ai_provider_credentials c
       set models_available = array_remove(array_remove(c.models_available, p_de), 'openai/' || p_de)
     where p_de = any(c.models_available) or ('openai/' || p_de) = any(c.models_available)
    returning c.id
  loop
    tipo := 'chave'; alvo := r.id::text; detalhe := p_de || ' removido da lista';
    return next;
  end loop;

  insert into public.berseba_modelos_aposentados (model_id, motivo)
  values (regexp_replace(p_de, '^[a-z0-9-]+/', ''), 'trocado por ' || p_para || ' em ' || current_date)
  on conflict (model_id) do nothing;

  for r in
    update public.ai_models m set deprecated_at = now()
     where public.berseba_modelo_aposentado(m.model_id) and m.deprecated_at is null
    returning m.model_id
  loop
    tipo := 'catalogo'; alvo := r.model_id; detalhe := 'aposentado';
    return next;
  end loop;
end;
$$;

comment on function public.berseba_trocar_modelo(text, text) is
  'Berseba 9448: troca um modelo de IA por outro em tudo (padrões, ligações, agentes publicados, chaves) e aposenta o antigo. Uso: select * from public.berseba_trocar_modelo(''antigo'', ''novo'');';

revoke all on function public.berseba_trocar_modelo(text, text) from public, anon, authenticated;
grant execute on function public.berseba_trocar_modelo(text, text) to service_role;
