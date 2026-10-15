-- manifest: conversations_select resolves the viewer's visibility scope once per query (fn_conversation_visibility_scope) instead of calling fn_can_view_conversation per row — same rules, inbox lists and tab counts drop from seconds to milliseconds
--
-- Berseba fork migration (9NNN range, see BERSEBA.md): upstream numbers its
-- migrations sequentially and is in the 06xx range; a fork number in that range
-- would collide on the next sync.
--
-- Why. `conversations_select` called `fn_can_view_conversation(organization_id,
-- assigned_to_user_id)` for EVERY row. That function is a SECURITY DEFINER SQL
-- function with `set search_path`, so the planner cannot inline it, and on
-- Postgres < 18 a non-inlined SQL function re-plans its body on every call —
-- together with the nested `fn_user_role_in_org` (twice) → `fn_support_context`
-- (a join over auth.sessions/auth.mfa_factors). Measured in production
-- (2026-10-14, Supabase Small, PG17): ~14 ms per row; counting 290
-- conversations as an attendant took 3,994 ms, and the inbox tab counts hit the
-- 8 s `statement_timeout` of `authenticated` ~1,300 times a day.
--
-- What. The scope does not depend on the row: it is "which organizations can
-- this user read, and in which visibility mode". `fn_conversation_visibility_scope()`
-- returns exactly that, and the policy only references it through UNCORRELATED
-- `in (select ...)` subqueries, which Postgres evaluates once per query as hashed
-- subplans. The per-row work becomes a hash lookup. Same count: 18.7 ms.
--
-- Same rules, branch by branch, as fn_can_view_conversation (which stays, and
-- is still used by other policies and functions):
--   · platform admin                       → every organization, all rows
--   · no role in the organization          → organization absent from the scope
--   · viewer / manager / admin             → all rows
--   · agent, conversation assigned to them → visible in any mode
--   · agent, mode 'all'                    → all rows
--   · agent, mode 'own_and_unassigned'     → plus the unassigned rows (the default)
--   · agent, any other mode ('own')        → only their own
-- Parity is measured per combination in
-- tests/invariants/conversation-visibility-once-per-query.test.ts.
--
-- `alter policy` instead of drop + create: the policy always exists here
-- (migration 0035), and altering it never leaves a window without a SELECT
-- policy. Idempotent: re-applying rewrites the same expression.

create or replace function public.fn_conversation_visibility_scope()
returns table (org_id uuid, visibility text)
language sql stable security definer
set search_path = public
as $$
  select o.id,
         case
           when (select public.fn_is_platform_admin()) then 'all'
           when public.fn_user_role_in_org(o.id) in ('viewer', 'manager', 'admin') then 'all'
           else coalesce(o.settings->>'visibility_mode', 'own_and_unassigned')
         end
  from public.organizations o
  where (select public.fn_is_platform_admin())
     or (o.id in (select public.fn_user_org_ids())
         and public.fn_user_role_in_org(o.id) is not null);
$$;

revoke all on function public.fn_conversation_visibility_scope() from public;
revoke execute on function public.fn_conversation_visibility_scope() from anon;
grant execute on function public.fn_conversation_visibility_scope()
  to authenticated, service_role;

alter policy "conversations_select" on public.conversations
  using (
    organization_id in (
      select s.org_id from public.fn_conversation_visibility_scope() s
      where s.visibility = 'all')
    or (assigned_to_user_id = (select auth.uid())
        and organization_id in (
          select s.org_id from public.fn_conversation_visibility_scope() s))
    or (assigned_to_user_id is null
        and organization_id in (
          select s.org_id from public.fn_conversation_visibility_scope() s
          where s.visibility = 'own_and_unassigned'))
  );
