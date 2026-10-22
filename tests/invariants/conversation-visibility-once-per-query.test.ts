import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * Migration 9001 (Berseba fork): `conversations_select` resolves the viewer's
 * visibility scope ONCE per query instead of calling `fn_can_view_conversation`
 * per row. Two things are measured here:
 *
 * 1. Parity. For every user × organization combination below, the rows the
 *    policy lets through are exactly the rows `fn_can_view_conversation` (the
 *    old per-row rule, which stays) says the same user can see. The expected
 *    counts are pinned too, so the parity cannot pass with both sides wrong.
 * 2. Cost. Counted with `track_functions`, not read from the plan text: a
 *    count as an agent runs the scope function ONCE and never
 *    `fn_can_view_conversation`, whatever the number of rows — the property
 *    that took the production count from 3,994 ms to 18.7 ms, and that keeps
 *    the per-event Realtime check as cheap as the old per-row call. The same
 *    holds for `messages_select`. Without these cases a rewrite back to a
 *    per-row call would keep the parity green and bring the timeouts back.
 *
 * Support sessions are not a separate row of the matrix on purpose: one is
 * only ever active for a platform admin (`fn_support_context` revokes it when
 * the actor is not in `platform_admins`), and a platform admin sees every
 * organization by the first rule — the PLATFORM user below.
 */

// Namespace 9001xxxx — exclusive to this file.
const ORG_ALL = "90010000-0000-4000-8000-000000000001"; // visibility_mode = 'all'
const ORG_DEFAULT = "90010000-0000-4000-8000-000000000002"; // no setting → 'own_and_unassigned'
const ORG_OWN = "90010000-0000-4000-8000-000000000003"; // 'own'
const ORG_ODD = "90010000-0000-4000-8000-000000000004"; // unknown value → only own
const ORGS = [ORG_ALL, ORG_DEFAULT, ORG_OWN, ORG_ODD];

const AGENT = "90010000-1111-4000-8000-000000000001"; // agent in every org
const OTHER = "90010000-1111-4000-8000-000000000002"; // agent in every org, owns the "other" rows
const VIEWER = "90010000-1111-4000-8000-000000000003"; // viewer in ORG_OWN
const MANAGER = "90010000-1111-4000-8000-000000000004"; // manager in ORG_OWN
const ADMIN = "90010000-1111-4000-8000-000000000005"; // admin in ORG_OWN
const PLATFORM = "90010000-1111-4000-8000-000000000006"; // platform admin, no membership
const OUTSIDER = "90010000-1111-4000-8000-000000000007"; // no membership at all
const REVOKED = "90010000-1111-4000-8000-000000000008"; // agent in ORG_ALL, revoked

const USERS: Array<[string, string]> = [
  [AGENT, "agent"],
  [OTHER, "other"],
  [VIEWER, "viewer"],
  [MANAGER, "manager"],
  [ADMIN, "admin"],
  [PLATFORM, "platform"],
  [OUTSIDER, "outsider"],
  [REVOKED, "revoked"],
];

const orgList = ORGS.map((o) => `'${o}'`).join(", ");

beforeAll(() => {
  const users = USERS.map(
    ([id, tag]) =>
      `insert into auth.users (id, email) values ('${id}', '${tag}-9001@invariant.test') on conflict do nothing;`,
  ).join("\n");
  const modes: Array<[string, string]> = [
    [ORG_ALL, `jsonb_build_object('visibility_mode', 'all')`],
    [ORG_DEFAULT, `'{}'::jsonb`],
    [ORG_OWN, `jsonb_build_object('visibility_mode', 'own')`],
    [ORG_ODD, `jsonb_build_object('visibility_mode', 'not-a-mode')`],
  ];
  const orgs = modes
    .map(
      ([id, settings], i) => `
    insert into public.organizations (id, slug, legal_name, display_name, settings)
      values ('${id}', 'vis-9001-${i}', 'Vis 9001 ${i}', 'Vis 9001 ${i}', ${settings})
      on conflict do nothing;
    do $v$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('90010000-2222-4000-8000-00000000000${i}', '${id}', 'vis-9001-${i}', '\\x00'::bytea);
    exception when unique_violation then null; end $v$;
    insert into public.contacts (id, organization_id, display_name)
      select ('90010000-3333-4000-8000-0000000' || '${i}' || lpad(n::text, 4, '0'))::uuid,
             '${id}', 'Vis 9001 contact ' || n
      from generate_series(1, 3) n
      on conflict do nothing;
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at)
      values
        ('90010000-4444-4000-8000-0000000${i}0001', '${id}', '90010000-3333-4000-8000-0000000${i}0001',
         '90010000-2222-4000-8000-00000000000${i}', 'open', null, null),
        ('90010000-4444-4000-8000-0000000${i}0002', '${id}', '90010000-3333-4000-8000-0000000${i}0002',
         '90010000-2222-4000-8000-00000000000${i}', 'claimed', '${AGENT}', now()),
        ('90010000-4444-4000-8000-0000000${i}0003', '${id}', '90010000-3333-4000-8000-0000000${i}0003',
         '90010000-2222-4000-8000-00000000000${i}', 'claimed', '${OTHER}', now())
      on conflict do nothing;
    insert into public.messages
      (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
      select ('90010000-7777-4000-8000-0000000${i}' || c || lpad(n::text, 3, '0'))::uuid, '${id}',
             ('90010000-4444-4000-8000-0000000${i}000' || c)::uuid,
             '90010000-2222-4000-8000-00000000000${i}',
             ('90010000-3333-4000-8000-0000000${i}000' || c)::uuid,
             'text', 'inbound', 'probe 9001'
        from generate_series(1, 3) c, generate_series(1, 2) n;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${AGENT}', '${id}', 'agent', now()), ('${OTHER}', '${id}', 'agent', now())
      on conflict do nothing;`,
    )
    .join("\n");

  sql(`
    ${users}
    ${orgs}
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${VIEWER}', '${ORG_OWN}', 'viewer', now()),
             ('${MANAGER}', '${ORG_OWN}', 'manager', now()),
             ('${ADMIN}', '${ORG_OWN}', 'admin', now())
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at, revoked_at)
      values ('${REVOKED}', '${ORG_ALL}', 'agent', now(), now())
      on conflict do nothing;
    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason)
      values ('${PLATFORM}', '${PLATFORM}', 'full', false, 'Invariant 9001')
      on conflict (user_id) do update set revoked_at = null, scope = 'full';
  `);
});

function claimsFor(userId: string): string {
  return `select set_config('request.jwt.claims', '{"sub":"${userId}","role":"authenticated"}', false);`;
}

/**
 * Every result line carries a marker: an empty set must not be confused with
 * whatever psql printed before it (the `set_config` echo, for one — a bare
 * "last line" read it as a two-element list).
 */
function idsAfter(marker: string, out: string): string {
  const line = out.split("\n").find((l) => l.startsWith(`${marker}:`));
  if (line === undefined) throw new Error(`no ${marker} line in psql output: ${out}`);
  return line.slice(marker.length + 1);
}

function idsQuery(marker: string, org: string, extra = ""): string {
  return `select '${marker}:' || coalesce(string_agg(id::text, ',' order by id), '')
            from public.conversations where organization_id = '${org}' ${extra};`;
}

/** Ids the POLICY lets through, as the user, under RLS. */
function visibleThroughPolicy(userId: string, org: string): string {
  const out = sql(`
    set role authenticated;
    ${claimsFor(userId)}
    ${idsQuery("policy", org)}
  `);
  return idsAfter("policy", out);
}

/**
 * Both sides for one user, every organization, in ONE psql session: the old
 * per-row rule first (as the table owner, so RLS does not filter it), then the
 * policy as `authenticated`.
 */
function bothSides(userId: string): Array<[string, string, string]> {
  const oldRule = ORGS.map((org, i) =>
    idsQuery(
      `old${i}`,
      org,
      "and public.fn_can_view_conversation(organization_id, assigned_to_user_id)",
    ),
  ).join("\n");
  const policy = ORGS.map((org, i) => idsQuery(`policy${i}`, org)).join("\n");
  const out = sql(`
    ${claimsFor(userId)}
    ${oldRule}
    set role authenticated;
    ${policy}
  `);
  return ORGS.map((org, i) => [org, idsAfter(`policy${i}`, out), idsAfter(`old${i}`, out)]);
}

/**
 * Runs `query` as the user and returns how many times each watched function
 * ran, read from `pg_stat_xact_user_functions` in the same transaction, plus
 * the count the query returned (`rows`).
 */
function callsDuring(userId: string, query: string): Record<string, number> {
  const out = sql(`
    begin;
    set local track_functions = 'all';
    ${claimsFor(userId)}
    set local role authenticated;
    select 'rows:' || (${query.replace(/;\s*$/, "")});
    reset role;
    select 'calls:' || coalesce(string_agg(funcname || '=' || calls, ',' order by funcname), '')
      from pg_stat_xact_user_functions
     where schemaname = 'public'
       and funcname in ('fn_conversation_visibility_scope', 'fn_can_view_conversation', 'fn_is_platform_admin');
    commit;
  `);
  const calls: Record<string, number> = { rows: Number(idsAfter("rows", out)) };
  for (const pair of idsAfter("calls", out).split(",").filter(Boolean)) {
    const [name, n] = pair.split("=");
    if (name !== undefined) calls[name] = Number(n);
  }
  return calls;
}

function count(ids: string): number {
  return ids === "" ? 0 : ids.split(",").length;
}

// Pinned expectations: [user, org, rows visible]. Each org has 3 rows:
// unassigned, assigned to AGENT, assigned to OTHER.
const EXPECTED: Array<[string, string, string, number]> = [
  ["agent", AGENT, ORG_ALL, 3],
  ["agent", AGENT, ORG_DEFAULT, 2],
  ["agent", AGENT, ORG_OWN, 1],
  ["agent", AGENT, ORG_ODD, 1],
  ["other", OTHER, ORG_DEFAULT, 2],
  ["other", OTHER, ORG_OWN, 1],
  ["viewer", VIEWER, ORG_OWN, 3],
  ["manager", MANAGER, ORG_OWN, 3],
  ["admin", ADMIN, ORG_OWN, 3],
  ["viewer", VIEWER, ORG_ALL, 0],
  ["platform", PLATFORM, ORG_OWN, 3],
  ["platform", PLATFORM, ORG_ODD, 3],
  ["outsider", OUTSIDER, ORG_ALL, 0],
  ["revoked", REVOKED, ORG_ALL, 0],
];

describe("conversations_select — scope once per query (migration 9001)", () => {
  for (const [tag, user, org, rows] of EXPECTED) {
    it(`${tag} sees ${rows} row(s) in org …${org.slice(-1)}`, () => {
      expect(count(visibleThroughPolicy(user, org))).toBe(rows);
    });
  }

  it("the policy and fn_can_view_conversation agree for every user × organization", () => {
    const divergent: string[] = [];
    for (const [user, tag] of USERS) {
      for (const [org, policy, oldRule] of bothSides(user)) {
        if (policy !== oldRule)
          divergent.push(`${tag} @ …${org.slice(-1)}: policy=[${policy}] old=[${oldRule}]`);
      }
    }
    expect(divergent).toEqual([]);
  }, 120_000);

  it("a conversation count runs the scope function once, and fn_can_view_conversation never", () => {
    const calls = callsDuring(
      AGENT,
      `select count(*) from public.conversations where organization_id in (${orgList});`,
    );
    expect(calls.rows).toBe(7);
    expect(calls.fn_conversation_visibility_scope).toBe(1);
    expect(calls.fn_can_view_conversation ?? 0).toBe(0);
  });

  it("a message count does not call a definer function per message row", () => {
    const calls = callsDuring(
      AGENT,
      `select count(*) from public.messages where organization_id in (${orgList});`,
    );
    // 7 visible conversations x 2 messages: the inheritance still holds.
    expect(calls.rows).toBe(14);
    expect(calls.fn_is_platform_admin).toBeLessThanOrEqual(2);
    expect(calls.fn_conversation_visibility_scope).toBe(1);
    expect(calls.fn_can_view_conversation ?? 0).toBe(0);
  });

  it("anon cannot execute the scope function (only authenticated and service_role)", () => {
    const grants = lastLine(
      sql(`
        select string_agg(r, ',' order by r) from unnest(array['anon','authenticated','service_role']) r
          where has_function_privilege(r, 'public.fn_conversation_visibility_scope()', 'execute');
      `),
    );
    expect(grants).toBe("authenticated,service_role");
  });
});
