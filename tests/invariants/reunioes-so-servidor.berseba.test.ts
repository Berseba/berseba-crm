import { describe, expect, it } from "vitest";

import { countAs, GOV_AGENT_A, sql } from "./gov-helpers";

/**
 * Berseba (migration 9011): `meeting_proposals` is SERVER-ONLY (the screen reads it through the
 * service role after checking the admin role). Same proof as `gmail-intake-so-servidor`, plus the
 * LGPD door (anonymizing the contact deletes their proposals) and the tenant fence on contact_id.
 */
const TABELA = "public.meeting_proposals";

describe("meeting proposals: only the server passes", () => {
  it("RLS on, no policy, no browser privilege, service_role has it", () => {
    expect(sql(`select relrowsecurity from pg_class where oid = '${TABELA}'::regclass`)).toBe("t");
    expect(sql(`select count(*) from pg_policies where schemaname = 'public' and tablename = 'meeting_proposals'`)).toBe("0");
    expect(
      sql(
        `select bool_and(not has_table_privilege(r, '${TABELA}', p))
           from unnest(array['anon','authenticated']) r, unnest(array['select','insert','update','delete']) p`,
      ),
    ).toBe("t");
    expect(sql(`select has_table_privilege('service_role', '${TABELA}', 'insert')`)).toBe("t");
  });

  it("an authenticated JWT of the same organization is refused too", () => {
    expect(() =>
      countAs(GOV_AGENT_A, `select count(*) from ${TABELA} where organization_id = 'cccccccc-0000-4000-8000-000000000001';`),
    ).toThrow();
  });

  it("anonymizing the contact deletes their proposals, and only theirs; 'nenhuma' keeps no text", () => {
    const out = sql(`
      create temp table resultado (v text);
      do $t$
      declare
        v_org uuid := gen_random_uuid();
        v_ana uuid := gen_random_uuid();
        v_bia uuid := gen_random_uuid();
      begin
        insert into public.organizations (id, slug, legal_name, display_name)
          values (v_org, 'reuniao-' || substr(v_org::text, 1, 8), 'reuniao', 'reuniao');
        insert into public.contacts (id, organization_id, name) values (v_ana, v_org, 'Ana'), (v_bia, v_org, 'Bia');
        insert into public.meeting_proposals (organization_id, source, source_id, contact_id, intent, status, title, excerpt, starts_at)
        values
          (v_org, 'email', gen_random_uuid(), v_ana, 'pede', 'proposta', 'Proposta', 'Podemos conversar quinta?', now() + interval '6 days'),
          (v_org, 'whatsapp', gen_random_uuid(), v_bia, 'confirma', 'proposta', null, 'confirmado amanhã', now() + interval '1 day');
        begin
          insert into public.meeting_proposals (organization_id, source, source_id, contact_id, intent, status, excerpt)
          values (v_org, 'whatsapp', gen_random_uuid(), v_bia, 'nenhuma', 'nenhuma', 'texto que não pode ficar');
          insert into resultado values ('nenhuma_com_texto_aceita');
        exception when check_violation then
          insert into resultado values ('nenhuma_com_texto_recusada');
        end;
        update public.contacts set is_anonymized = true, anonymized_at = now() where id = v_ana;
        insert into resultado select 'restam=' || string_agg(intent, ',') from public.meeting_proposals where organization_id = v_org;
      end
      $t$;
      select v from resultado;
    `);
    expect(out).toContain("nenhuma_com_texto_recusada");
    expect(out).toContain("restam=confirma");
  });

  it("a proposal read from an e-mail goes with that e-mail (anonymization by address included)", () => {
    const out = sql(`
      create temp table resultado (v text);
      do $t$
      declare
        v_org uuid := gen_random_uuid();
        v_user uuid := gen_random_uuid();
        v_ana uuid := gen_random_uuid();
        v_caixa uuid := gen_random_uuid();
        v_email uuid := gen_random_uuid();
      begin
        insert into public.organizations (id, slug, legal_name, display_name)
          values (v_org, 'reuniao-e-' || substr(v_org::text, 1, 8), 'e', 'e');
        insert into auth.users (id, email) values (v_user, 'socio-' || v_user || '@empresa.test');
        insert into public.contacts (id, organization_id, name, email) values (v_ana, v_org, 'Ana', 'ana@cliente.test');
        insert into public.gmail_mailboxes (id, organization_id, user_id, account_email)
          values (v_caixa, v_org, v_user, 'socio-' || v_caixa || '@empresa.test');
        -- Stored before the contact existed: no contact_id on the e-mail nor on the proposal.
        insert into public.gmail_messages (id, organization_id, mailbox_id, gmail_message_id, gmail_thread_id, direction, from_email, sent_at, counterpart_email)
          values (v_email, v_org, v_caixa, 'm1', 't1', 'inbound', 'ana@cliente.test', now(), 'ana@cliente.test');
        insert into public.meeting_proposals (organization_id, source, source_id, intent, status, excerpt)
          values (v_org, 'email', v_email, 'pede', 'proposta', 'Podemos conversar quinta?');
        update public.contacts set is_anonymized = true, anonymized_at = now(), email = null where id = v_ana;
        insert into resultado select 'propostas=' || count(*) from public.meeting_proposals where organization_id = v_org;
      end
      $t$;
      select v from resultado;
    `);
    expect(out).toContain("propostas=0");
  });

  it("a proposal cannot point at another organization's contact", () => {
    const out = sql(`
      create temp table resultado (v text);
      do $t$
      declare
        v_org uuid := gen_random_uuid();
        v_outra uuid := gen_random_uuid();
        v_contato uuid := gen_random_uuid();
      begin
        insert into public.organizations (id, slug, legal_name, display_name) values
          (v_org, 'reuniao-a-' || substr(v_org::text, 1, 8), 'a', 'a'),
          (v_outra, 'reuniao-b-' || substr(v_outra::text, 1, 8), 'b', 'b');
        insert into public.contacts (id, organization_id, name) values (v_contato, v_outra, 'Outra');
        begin
          insert into public.meeting_proposals (organization_id, source, source_id, contact_id, intent, status)
          values (v_org, 'email', gen_random_uuid(), v_contato, 'pede', 'proposta');
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
