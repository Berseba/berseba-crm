-- 0239 — comando_da_conversa lê o contato UMA vez, não duas.
--
-- Incidente de 2026-09-28 (docs/incidentes/2026-09-28-inbox-lenta.md): a Fila e as
-- três contagens de abas filtram por `comando_da_conversa(c.*)`, avaliada linha a
-- linha. A versão da 0203 fazia DUAS subconsultas em `contacts` (force_human e
-- is_blocked), e cada uma paga a RLS `tenant_isolation_contacts_all` inteira
-- (`fn_user_org_ids()` → `fn_support_context()`). Uma leitura só traz os dois campos
-- e paga a RLS uma vez. Medido na VPS dos clientes (Studio, 146 conversas, banco
-- ocioso, como admin da org): contagem da Fila 491 ms → 263 ms.
--
-- Segurança inalterada: continua SECURITY INVOKER, a leitura de contacts continua
-- sob a RLS de quem chama. Contato invisível → os dois campos caem em `false`, como
-- antes.
--
-- Isto é paliativo. O custo ainda cresce com o número de conversas da org, porque a
-- RLS de contacts roda uma vez por linha. O conserto definitivo é materializar o
-- comando numa coluna indexada (ver o relatório do incidente).
--
-- Conferido antes de aplicar: as 205 conversas do banco dão o mesmo comando nas duas
-- versões (0 diferenças).
--
-- Reverter: reaplicar a definição de `public.comando_da_conversa` da 0203
-- (supabase/migrations/20260831000000_0203_comando_da_conversa.sql, linha 74).

create or replace function public.comando_da_conversa(c public.conversations)
returns text
language sql
stable
set search_path = public
as $$
  select public.fn_comando_da_conversa(
    c.status,
    c.assigned_to_user_id,
    c.bot_silenced_until,
    -- `coalesce` porque `contact_id` é anulável e a RLS pode esconder o contato:
    -- nos dois casos o LEFT JOIN devolve null, e null não pode tirar a conversa de
    -- todas as abas.
    coalesce(x.force_human, false),
    coalesce(x.is_blocked, false),
    now()
  )
  from (select 1) as d
  left join lateral (
    select ct.force_human, ct.is_blocked
    from public.contacts ct
    where ct.id = c.contact_id
  ) as x on true;
$$;
