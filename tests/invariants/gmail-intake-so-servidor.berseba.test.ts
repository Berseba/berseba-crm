import { describe, expect, it } from "vitest";

import { countAs, GOV_AGENT_A, sql } from "./gov-helpers";

/**
 * Berseba (migration 9010): `gmail_mailboxes` (the partner's Gmail tokens) and `gmail_messages`
 * (the e-mails read from it) are SERVER-ONLY. The screen reads them through the service role
 * after checking the session's role (admin), so no browser role may reach them, not even in its
 * own organization: RLS on, no policy, no privilege for anon/authenticated. Same proof as
 * `automation-claims-so-servidor.test.ts`. Plus the LGPD door: anonymizing the contact deletes
 * the e-mails linked to them.
 */
const TABELAS = ["gmail_mailboxes", "gmail_messages"] as const;

describe("Gmail intake: only the server passes", () => {
  for (const tabela of TABELAS) {
    it(`${tabela}: RLS on, no policy, no browser privilege, service_role has it`, () => {
      expect(sql(`select relrowsecurity from pg_class where oid = 'public.${tabela}'::regclass`)).toBe("t");
      expect(sql(`select count(*) from pg_policies where schemaname = 'public' and tablename = '${tabela}'`)).toBe("0");
      expect(
        sql(
          `select bool_and(not has_table_privilege(r, 'public.${tabela}', p))
             from unnest(array['anon','authenticated']) r, unnest(array['select','insert','update','delete']) p`,
        ),
      ).toBe("t");
      expect(sql(`select has_table_privilege('service_role', 'public.${tabela}', 'select')`)).toBe("t");
      expect(sql(`select has_table_privilege('service_role', 'public.${tabela}', 'insert')`)).toBe("t");
    });

    it(`${tabela}: an authenticated JWT of the same organization is refused too`, () => {
      expect(() =>
        countAs(
          GOV_AGENT_A,
          `select count(*) from public.${tabela} where organization_id = 'cccccccc-0000-4000-8000-000000000001';`,
        ),
      ).toThrow();
    });
  }

  it("anonymizing the contact deletes their e-mails, and only theirs", () => {
    const out = sql(`
      create temp table resultado (v text);
      do $t$
      declare
        v_org uuid := gen_random_uuid();
        v_user uuid := gen_random_uuid();
        v_ana uuid := gen_random_uuid();
        v_bia uuid := gen_random_uuid();
        v_caixa uuid := gen_random_uuid();
      begin
        insert into public.organizations (id, slug, legal_name, display_name) values (v_org, 'gmail-lgpd-' || substr(v_org::text, 1, 8), 'gmail-lgpd', 'gmail-lgpd');
        insert into auth.users (id, email) values (v_user, 'socio-' || v_user || '@empresa.test');
        insert into public.contacts (id, organization_id, name, email) values
          (v_ana, v_org, 'Ana', 'ana@cliente.test'),
          (v_bia, v_org, 'Bia', 'bia@cliente.test');
        insert into public.gmail_mailboxes (id, organization_id, user_id, account_email)
          values (v_caixa, v_org, v_user, 'socio@empresa.test');
        insert into public.gmail_messages
          (organization_id, mailbox_id, gmail_message_id, gmail_thread_id, direction, from_email, sent_at, counterpart_email, contact_id)
        values
          (v_org, v_caixa, 'm1', 't1', 'inbound', 'ana@cliente.test', now(), 'ana@cliente.test', v_ana),
          (v_org, v_caixa, 'm2', 't2', 'inbound', 'ana@cliente.test', now(), 'ana@cliente.test', null),
          (v_org, v_caixa, 'm3', 't3', 'inbound', 'bia@cliente.test', now(), 'bia@cliente.test', v_bia);
        update public.contacts set is_anonymized = true, anonymized_at = now(), email = null where id = v_ana;
        insert into resultado select 'restam=' || string_agg(gmail_message_id, ',' order by gmail_message_id)
                                    from public.gmail_messages where organization_id = v_org;
      end
      $t$;
      select v from resultado;
    `);
    expect(out).toContain("restam=m3");
  });

  it("a message cannot point at another organization's contact", () => {
    const out = sql(`
      create temp table resultado (v text);
      do $t$
      declare
        v_org uuid := gen_random_uuid();
        v_outra uuid := gen_random_uuid();
        v_user uuid := gen_random_uuid();
        v_contato uuid := gen_random_uuid();
        v_caixa uuid := gen_random_uuid();
      begin
        insert into public.organizations (id, slug, legal_name, display_name) values
          (v_org, 'gmail-a-' || substr(v_org::text, 1, 8), 'gmail-a', 'gmail-a'),
          (v_outra, 'gmail-b-' || substr(v_outra::text, 1, 8), 'gmail-b', 'gmail-b');
        insert into auth.users (id, email) values (v_user, 'socio-' || v_user || '@empresa.test');
        insert into public.contacts (id, organization_id, name) values (v_contato, v_outra, 'Outra');
        insert into public.gmail_mailboxes (id, organization_id, user_id, account_email)
          values (v_caixa, v_org, v_user, 'socio@empresa.test');
        begin
          insert into public.gmail_messages
            (organization_id, mailbox_id, gmail_message_id, gmail_thread_id, direction, from_email, sent_at, contact_id)
          values (v_org, v_caixa, 'm1', 't1', 'inbound', 'x@y.test', now(), v_contato);
          insert into resultado values ('aceitou');
        exception when foreign_key_violation then
          insert into resultado values ('recusou');
        end;
      end
      $t$;
      select v from resultado;
    `);
    expect(out).toContain("recusou");
  });
});
