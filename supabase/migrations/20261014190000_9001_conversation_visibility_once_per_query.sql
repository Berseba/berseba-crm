-- manifest: conversations_select resolves the viewer's visibility scope once per statement (fn_conversation_visibility_scope) instead of calling fn_can_view_conversation per row, and messages_select stops calling fn_is_platform_admin per row — same rules, inbox lists and tab counts drop from seconds to milliseconds
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
-- What. The scope does not depend on the row: it is "in which organizations,
-- and for which kind of row, can this user read". `fn_conversation_visibility_scope()`
-- returns exactly that as (organization, slice) pairs, where the slice of a row
-- is 'mine' (assigned to the caller), 'unassigned' or 'others'. The policy
-- reads it through ONE uncorrelated `(organization_id, slice) in (select ...)`,
-- so the function runs once per statement and the per-row work is a lookup.
-- Same count: 18.7 ms.
--
-- Once, not three times: Realtime evaluates this policy for every change and
-- every subscriber, one row at a time. With one scope evaluation per statement
-- that check costs about what the old single per-row call did (~12 ms vs
-- ~14 ms); three separate subqueries would have cost ~36 ms per event.
--
-- The role lookup runs once per member organization (a materialized CTE over
-- `fn_user_org_ids()`, never a scan of every organization), and not at all for
-- a platform admin, who sees every organization.
--
-- `messages_select` (same 0035 block) gets the same treatment for its first
-- branch: `fn_is_platform_admin()` was called once per message row; wrapped in
-- `(select ...)` it is one initPlan. Its second branch already reads
-- conversations, which now resolve their scope once.
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
--   · support session                      → only ever active for a platform
--                                            admin, so it is the first line
-- Parity is measured per combination in
-- tests/invariants/conversation-visibility-once-per-query.test.ts.
--
-- `alter policy` instead of drop + create: the policy always exists here
-- (migration 0035), and altering it never leaves a window without a SELECT
-- policy. Idempotent: re-applying rewrites the same expression.

create or replace function public.fn_conversation_visibility_scope()
returns table (org_id uuid, slice text)
language sql stable security definer
set search_path = public
as $$
  with me as materialized (
    select public.fn_is_platform_admin() as is_platform_admin
  ),
  members as materialized (
    select u.org_id, public.fn_user_role_in_org(u.org_id) as role
      from public.fn_user_org_ids() as u(org_id), me
     where not me.is_platform_admin and u.org_id is not null
  ),
  visible as (
    select o.id as org_id, 'all'::text as visibility
      from public.organizations o, me
     where me.is_platform_admin
    union all
    select m.org_id,
           case
             when m.role in ('viewer', 'manager', 'admin') then 'all'
             else coalesce(
               (select o.settings->>'visibility_mode'
                  from public.organizations o where o.id = m.org_id),
               'own_and_unassigned')
           end
      from members m
     where m.role is not null
  )
  select v.org_id, s.slice
    from visible v
   cross join (values ('mine'), ('unassigned'), ('others')) as s(slice)
   where s.slice = 'mine'
      or v.visibility = 'all'
      or (v.visibility = 'own_and_unassigned' and s.slice = 'unassigned');
$$;

revoke all on function public.fn_conversation_visibility_scope() from public;
revoke execute on function public.fn_conversation_visibility_scope() from anon;
grant execute on function public.fn_conversation_visibility_scope()
  to authenticated, service_role;

alter policy "conversations_select" on public.conversations
  using (
    (organization_id,
     case
       when assigned_to_user_id = (select auth.uid()) then 'mine'
       when assigned_to_user_id is null then 'unassigned'
       else 'others'
     end)
    in (select s.org_id, s.slice from public.fn_conversation_visibility_scope() s)
  );

alter policy "messages_select" on public.messages
  using (
    (select public.fn_is_platform_admin())
    or exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id
    )
  );
