/**
 * Berseba: a hard age limit on the agent's conversation history, per organization
 * (`organizations.settings.ai.history_max_age_hours`, lib/agent-engine/edge/crm/get-lead-context.ts).
 *
 * Measured at RBCOR on 2026-11-12: in a conversation that was never closed, the agent quoted a
 * "dor lombar" from a test nine days before. What this file proves, on Postgres with the baseline:
 *   1. without the setting nothing changes (the old message stays);
 *   2. with it, messages older than N hours before the latest inbound are dropped;
 *   3. the latest inbound (the message the turn answers) always stays, even when the turn runs
 *      long after it (a follow-up a day later still sees the last exchange);
 *   4. a malformed value is ignored instead of breaking the turn.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getLeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";

import { GOV_ORG, GOV_SESSION, seedGov } from "./gov-helpers";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});

type Conv = { contato: string; conversa: string };

async function novaConversa(): Promise<Conv> {
  const contato = randomUUID();
  const conversa = randomUUID();
  await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,'Idade')", [
    contato,
    GOV_ORG,
  ]);
  await pool.query(
    `insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')`,
    [conversa, GOV_ORG, contato, GOV_SESSION],
  );
  return { contato, conversa };
}

async function mensagem(
  c: Conv,
  direcao: "inbound" | "outbound",
  corpo: string,
  ha: string,
): Promise<void> {
  const quando = `now() - interval '${ha}'`;
  await pool.query(
    `insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,body,sent_at)
     values($1,$2,$3,$4,$5,'text',$6,$7,'ai',$8,${quando})`,
    [
      randomUUID(),
      GOV_ORG,
      c.conversa,
      GOV_SESSION,
      c.contato,
      direcao,
      direcao === "inbound" ? "received" : "sent",
      corpo,
    ],
  );
  await pool.query(`select fn_mark_conversation_message($1,$2,$3,${quando})`, [
    c.conversa,
    direcao,
    corpo,
  ]);
}

async function corpos(c: Conv): Promise<string[]> {
  const r = await getLeadContext(
    pool,
    {} as never,
    { tenantId: GOV_ORG, leadId: c.contato, conversationId: c.conversa, fuso: "America/Sao_Paulo" },
    { historyLimit: 20, maxTokens: 4000 },
  );
  if (!r.ok) throw new Error("contexto não montou");
  return r.context.messages.map((m) => m.body);
}

async function limite(valor: unknown): Promise<void> {
  await pool.query(
    `update organizations
        set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{ai}',
          coalesce(settings->'ai', '{}'::jsonb) || jsonb_build_object('history_max_age_hours', $2::jsonb))
      where id = $1`,
    [GOV_ORG, JSON.stringify(valor)],
  );
}

beforeAll(() => {
  seedGov();
});
beforeEach(async () => {
  await pool.query(
    `update organizations set settings = settings #- '{ai,history_max_age_hours}' where id = $1`,
    [GOV_ORG],
  );
});
afterAll(async () => {
  await pool.end();
});

async function conversaDeNoveDias(): Promise<Conv> {
  const c = await novaConversa();
  await mensagem(c, "inbound", "TENHO_DOR_LOMBAR", "9 days");
  await mensagem(c, "outbound", "RESPOSTA_ANTIGA", "9 days");
  await mensagem(c, "inbound", "Quero marcar uma aula", "2 hours");
  await mensagem(c, "outbound", "Temos sexta às 7h", "1 hour");
  await mensagem(c, "inbound", "Pode ser", "1 minute");
  return c;
}

describe("history_max_age_hours", () => {
  it("absent: the old messages stay (upstream behaviour)", async () => {
    const c = await conversaDeNoveDias();
    expect(await corpos(c)).toContain("TENHO_DOR_LOMBAR");
  });

  it("12 h: drops what is older than 12 h before the latest inbound", async () => {
    await limite(12);
    const c = await conversaDeNoveDias();
    expect(await corpos(c)).toEqual(["Quero marcar uma aula", "Temos sexta às 7h", "Pode ser"]);
  });

  it("the latest inbound always stays, even when the turn runs long after it", async () => {
    await limite(1);
    const c = await novaConversa();
    await mensagem(c, "inbound", "PERGUNTA_ANTIGA", "30 hours");
    await mensagem(c, "outbound", "RESPOSTA_DA_ANTIGA", "29 hours");
    await mensagem(c, "inbound", "ULTIMA_DA_PESSOA", "24 hours");
    expect(await corpos(c)).toEqual(["ULTIMA_DA_PESSOA"]);
  });

  it("a malformed value is ignored", async () => {
    for (const valor of ["doze", 0, -5, 1.5, "12; drop table messages"]) {
      await limite(valor);
      const c = await conversaDeNoveDias();
      expect(await corpos(c), String(valor)).toContain("TENHO_DOR_LOMBAR");
    }
  });
});
