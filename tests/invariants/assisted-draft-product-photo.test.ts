/**
 * AN ASSISTED-MODE DRAFT CARRIES THE PRODUCT PHOTO (Berseba, migration 9004).
 *
 * Measured against the real baseline, the real approval worker
 * (`createApprovedReplyHandler`) and an HTTP receiver standing in for WAHA:
 *
 * - the column keeps the table's RLS: a member of another organization does not
 *   see the draft, and `authenticated` cannot write the column;
 * - an approved draft with a product goes out as ONE image whose caption is the
 *   EDITED body, and the receipt recognises it (draft `sent`, message `sent`);
 * - an invalid code, a caption over the limit, or a photo that could not be
 *   copied never reaches the receiver.
 */
import { createAdminClient } from "@/lib/supabase/admin";
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
import { createApprovedReplyHandler } from "@/lib/agent-engine/agent/approved-reply";
import type { CopiarFoto } from "@/lib/agent-engine/agent/fotos-do-produto";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { meetPgSupabase } from "../support/meet-pg-supabase";
import { criarOrigemDeFollowup } from "./followup-service-origin";
import { GOV_AGENT_A, GOV_AGENT_B, seedGov } from "./gov-helpers";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 6,
});
beforeAll(() => seedGov());
afterAll(() => pool.end());

const EDITED = "Oi! Essas são as mechas morena que fizemos semana passada. Quer agendar?";

/** An organization with an Assisted agent, a conversation and, optionally, the product. */
async function fixture(members: string[], product?: { code: string; photos: number }) {
  const org = randomUUID(),
    contact = randomUUID(),
    agent = randomUUID(),
    version = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Salão','Salão')",
    [org],
  );
  for (const user of members)
    await pool.query(
      "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'agent',now())",
      [org, user],
    );
  await pool.query(
    "insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Cliente','+5531998765432')",
    [contact, org],
  );
  const boundary = await criarOrigemDeFollowup(pool, org, contact),
    conversation = boundary.conversation_id;
  await pool.query(
    "update conversations set assigned_to_user_id=$1 where organization_id=$2 and id=$3",
    [members[0], org, conversation],
  );
  const channel = (
    await pool.query(
      "select channel_session_id from conversations where organization_id=$1 and id=$2",
      [org, conversation],
    )
  ).rows[0].channel_session_id;
  await pool.query(
    "insert into channel_knobs(organization_id,channel_session_id,throttle_ms,jitter_max_ms,window_start_hour,window_end_hour) values($1,$2,0,0,0,24)",
    [org, channel],
  );
  await pool.query(
    "insert into ai_agents(id,organization_id,name,system_prompt,operation_mode) values($1,$2,'Assistente','Ajude.','assisted')",
    [agent, org],
  );
  await pool.query(
    "insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status) values($1,$2,$3,1,'Ajude.','anthropic','test-model',$4,'published')",
    [version, org, agent, channel],
  );
  await pool.query(
    "update ai_agents set published_version_id=$1 where organization_id=$2 and id=$3",
    [version, org, agent],
  );
  if (product) {
    const productId = randomUUID();
    const photos = Array.from({ length: product.photos }, () => `${org}/${productId}/${randomUUID()}.jpg`);
    await pool.query(
      "insert into catalog_products(id,organization_id,codigo,nome,preco_cents,fotos) values($1,$2,$3,'Mechas morena',35000,$4)",
      [productId, org, product.code, photos],
    );
  }
  return { org, contact, agent, version, conversation, channel };
}
type F = Awaited<ReturnType<typeof fixture>>;

/** A pending draft, as `generateReplyDraft` leaves it, carrying `productCode`. */
async function pendingDraft(f: F, productCode: string | null) {
  const d = (
    await pool.query("select * from fn_reply_begin($1,$2,$3,$4,$5)", [
      f.org,
      f.conversation,
      f.agent,
      f.version,
      randomUUID(),
    ])
  ).rows[0];
  return (
    await pool.query(
      "update ai_reply_drafts set status='pending',original_body='Olá',edited_body='Olá',product_code=$3 where organization_id=$1 and id=$2 returning *",
      [f.org, d.id, productCode],
    )
  ).rows[0];
}

async function asUser(user: string, sql: string, args: unknown[]) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: user, role: "authenticated", aal: "aal1" }),
    ]);
    const r = await c.query(sql, args);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

/** Approves with the attendant's edited body and claims the job, as the worker would. */
async function approveAndClaim(f: F, draft: Record<string, unknown>, body = EDITED) {
  const jid = (
    await asUser(GOV_AGENT_A, "select fn_reply_action($1,$2,$3,'approve',$4,null) as job", [
      f.org,
      draft.id,
      String(draft.revision),
      body,
    ])
  ).rows[0].job as string;
  return (
    await pool.query(
      "update job_queue set status='running',locked_by='photo-test',locked_at=clock_timestamp(),attempts=1 where organization_id=$1 and id=$2 returning *,locked_at::text claim_acquired_at",
      [f.org, jid],
    )
  ).rows[0];
}

/** Runs the real approval worker against a receiver that records every POST. */
async function deliver(job: Record<string, unknown>, copy: CopiarFoto) {
  const { createServer } = await import("node:http");
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const receiver = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.end(JSON.stringify({ numberExists: true, chatId: "5531998765432@c.us" }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    posts.push({ url: req.url ?? "", body: raw ? JSON.parse(raw) : {} });
    res.end(JSON.stringify({ id: "accepted-" + String(job.id) }));
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  const address = receiver.address();
  if (!address || typeof address === "string") throw Error("receiver");
  const url = process.env.WAHA_API_BASE_URL,
    key = process.env.WAHA_API_KEY;
  process.env.WAHA_API_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.WAHA_API_KEY = "test-receiver";
  const db = meetPgSupabase(pool);
  // The harness has no Storage: the send handler only needs a signed URL to hand WAHA.
  const supabase = new Proxy(db.client, {
    get(target, k) {
      if (k === "storage")
        return {
          from: () => ({
            createSignedUrl: async (path: string) => ({
              data: { signedUrl: `http://storage.test/${path}` },
              error: null,
            }),
          }),
        };
      const value = Reflect.get(target, k);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  vi.mocked(createAdminClient).mockReturnValue(supabase as never);
  try {
    await createApprovedReplyHandler({
      crmCfg: { supabase },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      sleep: async () => {},
      copyPhoto: () => copy,
    })(job as never, pool);
    return { posts, errors: db.errors };
  } finally {
    if (url === undefined) delete process.env.WAHA_API_BASE_URL;
    else process.env.WAHA_API_BASE_URL = url;
    if (key === undefined) delete process.env.WAHA_API_KEY;
    else process.env.WAHA_API_KEY = key;
    receiver.closeAllConnections();
    await new Promise<void>((r) => receiver.close(() => r()));
  }
}

const draftState = async (f: F, id: unknown) =>
  (
    await pool.query("select status,error_code from ai_reply_drafts where organization_id=$1 and id=$2", [
      f.org,
      id,
    ])
  ).rows[0];
const outbound = async (f: F) =>
  (
    await pool.query(
      "select type,status,body,media_storage_path from messages where organization_id=$1 and direction='outbound'",
      [f.org],
    )
  ).rows;

describe("ai_reply_drafts.product_code keeps the table's RLS", () => {
  it("is a nullable text column that authenticated can read but not write", async () => {
    const { rows } = await pool.query(
      `select data_type,is_nullable,
              has_column_privilege('authenticated','public.ai_reply_drafts','product_code','SELECT') can_read,
              has_column_privilege('authenticated','public.ai_reply_drafts','product_code','UPDATE') can_update,
              has_column_privilege('authenticated','public.ai_reply_drafts','product_code','INSERT') can_insert,
              (select relrowsecurity from pg_class where oid='public.ai_reply_drafts'::regclass) rls
         from information_schema.columns
        where table_schema='public' and table_name='ai_reply_drafts' and column_name='product_code'`,
    );
    expect(rows[0]).toEqual({
      data_type: "text",
      is_nullable: "YES",
      can_read: true,
      can_update: false,
      can_insert: false,
      rls: true,
    });
  });

  it("a member of another organization does not see the draft or its product", async () => {
    const mine = await fixture([GOV_AGENT_A], { code: "mechas-morena", photos: 1 });
    await fixture([GOV_AGENT_B]);
    const draft = await pendingDraft(mine, "mechas-morena");
    const sql = "select product_code from ai_reply_drafts where id=$1";
    expect((await asUser(GOV_AGENT_A, sql, [draft.id])).rows).toEqual([
      { product_code: "mechas-morena" },
    ]);
    expect((await asUser(GOV_AGENT_B, sql, [draft.id])).rows).toEqual([]);
  });
});

describe("Aprovar e enviar with a product photo", () => {
  it("sends ONE image of the cover with the edited text as its caption, and records the receipt", async () => {
    const f = await fixture([GOV_AGENT_A], { code: "mechas-morena", photos: 2 }),
      draft = await pendingDraft(f, "mechas-morena"),
      job = await approveAndClaim(f, draft);
    const copied: Array<[string, string]> = [];
    const r = await deliver(job, async (from, to) => (copied.push([from, to]), true));

    expect(r.posts, JSON.stringify(r.errors)).toHaveLength(1);
    expect(r.posts[0]!.url).toMatch(/sendImage/);
    expect(r.posts[0]!.body).toMatchObject({ caption: EDITED });
    expect(copied).toHaveLength(1);
    expect(copied[0]![1]).toMatch(new RegExp(`^${f.org}/${f.conversation}/catalogo-`));
    expect(await draftState(f, draft.id)).toEqual({ status: "sent", error_code: null });
    expect(await outbound(f)).toEqual([
      { type: "image", status: "sent", body: EDITED, media_storage_path: copied[0]![1] },
    ]);
  });

  it("a draft without a product still sends text, as before", async () => {
    const f = await fixture([GOV_AGENT_A]),
      job = await approveAndClaim(f, await pendingDraft(f, null));
    const copy = vi.fn(async () => true);
    const r = await deliver(job, copy);

    expect(r.posts, JSON.stringify(r.errors)).toHaveLength(1);
    expect(r.posts[0]!.url).toMatch(/sendText/);
    expect(copy).not.toHaveBeenCalled();
    expect(await outbound(f)).toEqual([
      { type: "text", status: "sent", body: EDITED, media_storage_path: null },
    ]);
  });

  it("an invalid product code sends nothing and fails the draft", async () => {
    const f = await fixture([GOV_AGENT_A], { code: "mechas-morena", photos: 1 }),
      draft = await pendingDraft(f, "nao-existe"),
      job = await approveAndClaim(f, draft);
    const copy = vi.fn(async () => true);
    const r = await deliver(job, copy);

    expect(r.posts).toEqual([]);
    expect(copy).not.toHaveBeenCalled();
    expect(await draftState(f, draft.id)).toEqual({
      status: "failed",
      error_code: "product_not_found",
    });
    expect(await outbound(f)).toEqual([]);
  });

  it("a caption over WhatsApp's limit sends nothing", async () => {
    const f = await fixture([GOV_AGENT_A], { code: "mechas-morena", photos: 1 }),
      draft = await pendingDraft(f, "mechas-morena"),
      job = await approveAndClaim(f, draft, "a".repeat(1025));
    const r = await deliver(job, async () => true);

    expect(r.posts).toEqual([]);
    expect(await draftState(f, draft.id)).toEqual({
      status: "failed",
      error_code: "caption_too_long",
    });
  });

  it("a photo that could not be copied sends nothing and the job is retried", async () => {
    const f = await fixture([GOV_AGENT_A], { code: "mechas-morena", photos: 1 }),
      draft = await pendingDraft(f, "mechas-morena"),
      job = await approveAndClaim(f, draft);
    const r = await deliver(job, async () => false);

    expect(r.posts).toEqual([]);
    expect(await draftState(f, draft.id)).toEqual({
      status: "approved",
      error_code: "product_photo_unavailable",
    });
    expect(
      (await pool.query("select status from job_queue where id=$1", [job.id])).rows[0].status,
    ).toBe("pending");
  });
});
