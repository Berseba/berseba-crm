-- 9447 — Berseba: um modelo aposentado não volta pelo cron do catálogo.
-- sync-model-catalog ressuscita (deprecated_at = null) todo modelo que reaparece na origem. Um
-- modelo que a Berseba aposentou por custo (regra de 25 Nov 2026: sempre o modelo de menor custo que
-- entrega) fica nesta lista, e o gatilho mantém a aposentadoria, também nas variantes (prefixo do
-- provedor, -pro, :batch). Aplicada em produção em 26 Nov 2026 pelo MCP do Supabase.

create table if not exists public.berseba_modelos_aposentados (
  model_id text primary key check (model_id ~ '^[a-z0-9][a-z0-9.\-]*$'),
  aposentado_em timestamptz not null default now(),
  motivo text not null
);
alter table public.berseba_modelos_aposentados enable row level security;
revoke all on public.berseba_modelos_aposentados from public, anon, authenticated;
grant select, insert, update, delete on public.berseba_modelos_aposentados to service_role;

create or replace function public.berseba_modelo_aposentado(p_model_id text)
returns boolean
language sql
stable
set search_path to 'public'
as $$
  select exists (
    select 1 from public.berseba_modelos_aposentados a
     where regexp_replace(regexp_replace(p_model_id, '^[a-z0-9-]+/', ''), ':.*$', '') = a.model_id
        or regexp_replace(regexp_replace(p_model_id, '^[a-z0-9-]+/', ''), ':.*$', '') like a.model_id || '-%'
  );
$$;

create or replace function public.fn_berseba_aposentado_nao_volta()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if new.deprecated_at is null and public.berseba_modelo_aposentado(new.model_id) then
    new.deprecated_at := coalesce(old.deprecated_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists trg_berseba_aposentado_nao_volta on public.ai_models;
create trigger trg_berseba_aposentado_nao_volta
  before insert or update on public.ai_models
  for each row execute function public.fn_berseba_aposentado_nao_volta();

insert into public.berseba_modelos_aposentados (model_id, motivo)
values ('gpt-5.6-luna', 'Matheus, 25 Nov 2026: custava o dobro do gpt-6-luna e era 84% do gasto de IA do CRM')
on conflict (model_id) do nothing;
