-- Sugestão de etapa (a IA sugere, o humano confirma): tabela que registra, por
-- negócio, o que o agente concluiu que deveria acontecer no funil quando o
-- knob `organizations.settings.crm.ai_stage_moves` está em "suggest" — ou
-- quando a etapa de destino fecha o negócio (`is_won`/`is_lost`), que é SEMPRE
-- sugestão, mesmo em "auto" (regra pura em lib/leads/stage-move-policy.ts).
--
-- Uma sugestão PENDENTE por negócio: o índice único parcial abaixo é a
-- garantia; quem marca a sugestão anterior como `stale` antes de inserir a
-- nova é o CÓDIGO (`lib/leads/agent-stage-sync.ts`), na mesma função que
-- insere — não um trigger, porque trigger Postgres não decide fluxo de
-- aplicação e a doutrina deste repo proíbe HTTP em trigger; aqui não há HTTP
-- nenhum, só duas escritas na mesma chamada, e mantê-las juntas em vez de
-- espalhar por gatilho é o que deixa a ordem visível para quem lê o código.
--
-- RLS e grants no mesmo padrão de `ai_reply_drafts` (migration 0227): a leitura
-- é do papel `authenticated` via `fn_user_org_ids()`, a escrita é do
-- `service_role` (agente/serviço decide; humano decide pelas rotas, que usam o
-- client admin com `organization_id` de fonte confiável — nunca do body).
create table if not exists public.crm_stage_move_suggestions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  from_stage_id uuid not null references public.crm_stages(id),
  to_stage_id uuid not null references public.crm_stages(id),
  agent_id uuid references public.ai_agents(id) on delete set null,
  -- Vocabulário ABERTO a crescer (só `agent_turn` hoje) — igual ao espírito de
  -- `crm_lead_activities.type`, mas aqui a tabela É NOVA (não há linha legada
  -- de clone para quebrar), então o CHECK entra desde já: cresce por migration
  -- quando um segundo emissor existir, nunca por string solta sem constraint.
  source text not null default 'agent_turn' check (source in ('agent_turn')),
  reason text,
  status text not null default 'pending' check (status in ('pending', 'applied', 'rejected', 'stale')),
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Uma sugestão PENDENTE por negócio — o "cinto" de verdade, no schema.
create unique index if not exists uniq_crm_stage_move_suggestions_pending
  on public.crm_stage_move_suggestions (lead_id)
  where status = 'pending';

create index if not exists crm_stage_move_suggestions_org_status
  on public.crm_stage_move_suggestions (organization_id, status, created_at desc);

alter table public.crm_stage_move_suggestions enable row level security;

revoke all on public.crm_stage_move_suggestions from anon, authenticated;
grant select on public.crm_stage_move_suggestions to authenticated;
grant all on public.crm_stage_move_suggestions to service_role;

-- `for select`, não `for all`: authenticated só tem GRANT de SELECT (acima) —
-- igual `ai_reply_drafts`. O sufixo `_all` no nome é a convenção do repo para
-- "policy de isolamento de tenant", não o escopo de comandos da policy.
drop policy if exists tenant_isolation_crm_stage_move_suggestions_all on public.crm_stage_move_suggestions;
create policy tenant_isolation_crm_stage_move_suggestions_all on public.crm_stage_move_suggestions
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));

drop trigger if exists trg_crm_stage_move_suggestions_set_updated_at on public.crm_stage_move_suggestions;
create trigger trg_crm_stage_move_suggestions_set_updated_at
  before update on public.crm_stage_move_suggestions
  for each row execute function public.fn_set_updated_at();

notify pgrst, 'reload schema';
