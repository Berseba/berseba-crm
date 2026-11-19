/**
 * Berseba (Berseba/berseba#270): the Prospector's reads.
 *
 *  - `crm_list_leads` gains `tag`: exact match on `tags`, in the query (before the limit and
 *    the cursor), with the organization filter kept;
 *  - `crm_list_lead_events`: touches, replies and meetings of a set of leads since a date,
 *    with no text and no contact data, scoped to the token's organization.
 *
 * `ctx.supabase` is a stub that records every query and answers per table.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn().mockResolvedValue(undefined),
  isServiceRoleConfigured: () => false,
}));

import { allTools } from "@/lib/mcp/tools";
import { catalogEntry } from "@/lib/mcp/tools/catalog";
import { crmListLeadEvents, saoPauloDay } from "@/lib/mcp/tools/lead-events";
import { crmListLeads } from "@/lib/mcp/tools/leads";
import type { McpContext } from "@/lib/mcp/types";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LEAD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LEAD_FOREIGN = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const CONTACT_A = "c0000000-0000-4000-8000-00000000000a";
const CONTACT_B = "c0000000-0000-4000-8000-00000000000b";
const CONV_A = "d0000000-0000-4000-8000-00000000000a";
const CONV_B = "d0000000-0000-4000-8000-00000000000b";
const SINCE = "2026-11-01T00:00:00-03:00";

interface Call {
  table: string;
  select?: string;
  eqs: Record<string, unknown>;
  ins: Record<string, unknown[]>;
  gtes: Record<string, unknown>;
  contains: Array<[string, unknown]>;
  ranges: Array<[number, number]>;
}

type Rows = Array<Record<string, unknown>>;
type Answer = (call: Call) => { data: Rows | null; error: { message: string } | null };

function makeCtx(
  answers: Record<string, Rows | Answer>,
  opts: { contatoDoTurno?: string } = {},
): { ctx: McpContext; calls: Call[] } {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, eqs: {}, ins: {}, gtes: {}, contains: [], ranges: [] };
    calls.push(call);
    const resolve = () => {
      const a = answers[table];
      if (typeof a === "function") return a(call);
      return { data: a ?? [], error: null };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: (cols: string) => {
        call.select = cols;
        return chain;
      },
      eq: (col: string, val: unknown) => {
        call.eqs[col] = val;
        return chain;
      },
      in: (col: string, vals: unknown[]) => {
        call.ins[col] = vals;
        return chain;
      },
      gte: (col: string, val: unknown) => {
        call.gtes[col] = val;
        return chain;
      },
      contains: (col: string, val: unknown) => {
        call.contains.push([col, val]);
        return chain;
      },
      range: (a: number, b: number) => {
        call.ranges.push([a, b]);
        return chain;
      },
      not: () => chain,
      or: () => chain,
      order: () => chain,
      limit: () => chain,
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(res, rej),
    };
    return chain;
  };
  const ctx = {
    organizationId: ORG,
    role: "agent",
    actor: { type: "api_token", id: "tok", role: "agent", api_token_id: "tok" },
    apiTokenId: "tok",
    requestId: "req",
    contatoDoTurno: opts.contatoDoTurno,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: { from, rpc: vi.fn() } as any,
  } as McpContext;
  return { ctx, calls };
}

/** The crm_leads stub answers only the ids of this org, like the real `.in` + `.eq`. */
const leadsOfOrg: Answer = (call) => {
  const rows = [
    { id: LEAD_A, contact_id: CONTACT_A, organization_id: ORG },
    { id: LEAD_B, contact_id: CONTACT_B, organization_id: ORG },
  ];
  const wanted = (call.ins.id ?? []) as string[];
  return {
    data: rows
      .filter((r) => call.eqs.organization_id === ORG && wanted.includes(r.id))
      .filter((r) => !call.eqs.contact_id || r.contact_id === call.eqs.contact_id)
      .map(({ id, contact_id }) => ({ id, contact_id })),
    error: null,
  };
};

const conversations: Rows = [
  { id: CONV_A, contact_id: CONTACT_A, channel: "whatsapp" },
  { id: CONV_B, contact_id: CONTACT_B, channel: "whatsapp" },
];

function parse(input: unknown) {
  return z.object(crmListLeadEvents.inputSchema).safeParse(input);
}

describe("crm_list_leads — tag filter", () => {
  it("passes the tag to the query as an exact `tags` containment, with the org filter", async () => {
    const { ctx, calls } = makeCtx({ crm_leads: [] });
    const input = z.object(crmListLeads.inputSchema).parse({ tag: "plano-enterprise" });
    await crmListLeads.handler(input, ctx);
    const leads = calls.find((c) => c.table === "crm_leads");
    expect(leads?.eqs.organization_id).toBe(ORG);
    expect(leads?.contains).toEqual([["tags", ["plano-enterprise"]]]);
  });

  it("without a tag, adds no tag filter", async () => {
    const { ctx, calls } = makeCtx({ crm_leads: [] });
    await crmListLeads.handler(z.object(crmListLeads.inputSchema).parse({}), ctx);
    expect(calls.find((c) => c.table === "crm_leads")?.contains).toEqual([]);
  });

  it("validates the tag length (1..80)", () => {
    const shape = z.object(crmListLeads.inputSchema);
    expect(shape.safeParse({ tag: "" }).success).toBe(false);
    expect(shape.safeParse({ tag: "x".repeat(81) }).success).toBe(false);
    expect(shape.safeParse({ tag: "x".repeat(80) }).success).toBe(true);
  });

  it("mentions the tag in the description the model reads", () => {
    expect(crmListLeads.description).toMatch(/tag/);
  });
});

describe("crm_list_lead_events — registration", () => {
  it("is a read for role agent with scope mcp:read, in the handlers and the catalog", () => {
    const tool = allTools.find((t) => t.name === "crm_list_lead_events");
    expect(tool).toBeDefined();
    expect(tool?.category).toBe("read");
    expect(tool?.requiresRole).toBe("agent");
    expect(tool?.requiresScope).toBe("mcp:read");
    expect(catalogEntry("crm_list_lead_events")?.risco).toBe("seguro");
  });
});

describe("crm_list_lead_events — input", () => {
  it("needs 1..100 uuids and an ISO datetime", () => {
    expect(parse({ lead_ids: [], since: SINCE }).success).toBe(false);
    expect(parse({ lead_ids: [LEAD_A], since: SINCE }).success).toBe(true);
    const many = Array.from({ length: 101 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    expect(parse({ lead_ids: many, since: SINCE }).success).toBe(false);
    expect(parse({ lead_ids: many.slice(0, 100), since: SINCE }).success).toBe(true);
    expect(parse({ lead_ids: ["not-a-uuid"], since: SINCE }).success).toBe(false);
    expect(parse({ lead_ids: [LEAD_A], since: "2026-11-01" }).success).toBe(false);
    expect(parse({ lead_ids: [LEAD_A], since: "2026-11-01T03:00:00Z" }).success).toBe(true);
  });
});

describe("crm_list_lead_events — events", () => {
  it("maps activities and messages to touch, reply and meeting, sorted by `at`", async () => {
    const { ctx } = makeCtx({
      crm_leads: leadsOfOrg,
      contacts: [],
      crm_lead_activities: [
        { lead_id: LEAD_A, type: "touch", channel: "email", performed_at: "2026-11-03T12:00:00+00:00" },
        { lead_id: LEAD_B, type: "appointment_scheduled", channel: null, performed_at: "2026-11-05T15:00:00+00:00" },
      ],
      conversations,
      messages: [
        { conversation_id: CONV_A, direction: "outbound", status: "sent", sent_at: "2026-11-02T13:00:00+00:00", created_at: null },
        { conversation_id: CONV_A, direction: "inbound", status: "received", sent_at: "2026-11-04T10:00:00+00:00", created_at: null },
      ],
    });
    const out = (await crmListLeadEvents.handler(
      { lead_ids: [LEAD_A, LEAD_B], since: SINCE },
      ctx,
    )) as { events: unknown[] };
    expect(out).toEqual({
      events: [
        { lead_id: LEAD_A, at: "2026-11-02T13:00:00.000Z", kind: "touch", channel: "whatsapp" },
        { lead_id: LEAD_A, at: "2026-11-03T12:00:00.000Z", kind: "touch", channel: "email" },
        { lead_id: LEAD_A, at: "2026-11-04T10:00:00.000Z", kind: "reply", channel: "whatsapp" },
        { lead_id: LEAD_B, at: "2026-11-05T15:00:00.000Z", kind: "meeting", channel: null },
      ],
    });
  });

  it("returns only lead_id, at, kind and channel: no text, names or phone numbers", async () => {
    const { ctx, calls } = makeCtx({
      crm_leads: leadsOfOrg,
      contacts: [],
      crm_lead_activities: [
        { lead_id: LEAD_A, type: "touch", channel: "linkedin", performed_at: "2026-11-03T12:00:00Z", payload: { note: "secret" } },
      ],
      conversations,
      messages: [
        { conversation_id: CONV_A, direction: "inbound", status: "received", sent_at: "2026-11-04T10:00:00Z", created_at: null, text: "oi, sou a Ana, 14 99999-0001" },
      ],
    });
    const out = (await crmListLeadEvents.handler({ lead_ids: [LEAD_A], since: SINCE }, ctx)) as {
      events: Array<Record<string, unknown>>;
    };
    for (const e of out.events) expect(Object.keys(e).sort()).toEqual(["at", "channel", "kind", "lead_id"]);
    expect(JSON.stringify(out)).not.toMatch(/Ana|99999|secret/);
    // And the queries never ask for message text or the activity's whole payload.
    expect(calls.find((c) => c.table === "messages")?.select).not.toMatch(/text|body|content/);
    expect(calls.find((c) => c.table === "crm_lead_activities")?.select).not.toMatch(/payload[^-]/);
  });

  it("collapses messages to the first one per lead, São Paulo day and kind", async () => {
    const { ctx } = makeCtx({
      crm_leads: leadsOfOrg,
      contacts: [],
      crm_lead_activities: [],
      conversations,
      messages: [
        // 2026-11-02 in São Paulo: 09:00, 10:00 and 23:30 local (02:30Z next day).
        { conversation_id: CONV_A, direction: "outbound", status: "sent", sent_at: "2026-11-02T13:00:00Z", created_at: null },
        { conversation_id: CONV_A, direction: "outbound", status: "read", sent_at: "2026-11-02T12:00:00Z", created_at: null },
        { conversation_id: CONV_A, direction: "outbound", status: "delivered", sent_at: "2026-11-03T02:30:00Z", created_at: null },
        // 2026-11-03 in São Paulo.
        { conversation_id: CONV_A, direction: "outbound", status: "sent", sent_at: "2026-11-03T12:00:00Z", created_at: null },
        // Two replies the same day.
        { conversation_id: CONV_A, direction: "inbound", status: "received", sent_at: "2026-11-02T14:00:00Z", created_at: null },
        { conversation_id: CONV_A, direction: "inbound", status: "received", sent_at: "2026-11-02T15:00:00Z", created_at: null },
      ],
    });
    const out = (await crmListLeadEvents.handler({ lead_ids: [LEAD_A], since: SINCE }, ctx)) as {
      events: Array<{ at: string; kind: string }>;
    };
    expect(out.events.map((e) => [e.kind, e.at])).toEqual([
      ["touch", "2026-11-02T12:00:00.000Z"],
      ["reply", "2026-11-02T14:00:00.000Z"],
      ["touch", "2026-11-03T12:00:00.000Z"],
    ]);
    expect(saoPauloDay("2026-11-03T02:30:00Z")).toBe("2026-11-02");
  });

  it("skips failed sends, outbound outside WhatsApp, and group conversations at the query", async () => {
    const CONV_IG = "d0000000-0000-4000-8000-0000000000ee";
    const { ctx, calls } = makeCtx({
      crm_leads: leadsOfOrg,
      contacts: [],
      crm_lead_activities: [],
      conversations: [...conversations, { id: CONV_IG, contact_id: CONTACT_A, channel: "instagram" }],
      messages: [
        { conversation_id: CONV_A, direction: "outbound", status: "failed", sent_at: "2026-11-02T12:00:00Z", created_at: null },
        { conversation_id: CONV_IG, direction: "outbound", status: "sent", sent_at: "2026-11-02T12:00:00Z", created_at: null },
        { conversation_id: CONV_IG, direction: "inbound", status: "received", sent_at: "2026-11-02T13:00:00Z", created_at: null },
      ],
    });
    const out = (await crmListLeadEvents.handler({ lead_ids: [LEAD_A], since: SINCE }, ctx)) as {
      events: unknown[];
    };
    expect(out.events).toEqual([
      { lead_id: LEAD_A, at: "2026-11-02T13:00:00.000Z", kind: "reply", channel: "instagram" },
    ]);
    expect(calls.find((c) => c.table === "conversations")?.eqs.is_group).toBe(false);
  });

  it("filters `since` in every query and drops anything older", async () => {
    const { ctx, calls } = makeCtx({
      crm_leads: leadsOfOrg,
      contacts: [],
      crm_lead_activities: [
        { lead_id: LEAD_A, type: "touch", channel: "email", performed_at: "2026-10-31T23:00:00Z" },
        { lead_id: LEAD_A, type: "touch", channel: "email", performed_at: "2026-11-01T03:00:00Z" },
      ],
      conversations,
      messages: [
        { conversation_id: CONV_A, direction: "inbound", status: "received", sent_at: "2026-11-01T02:59:59Z", created_at: null },
      ],
    });
    const out = (await crmListLeadEvents.handler({ lead_ids: [LEAD_A], since: SINCE }, ctx)) as {
      events: unknown[];
    };
    expect(out.events).toEqual([
      { lead_id: LEAD_A, at: "2026-11-01T03:00:00.000Z", kind: "touch", channel: "email" },
    ]);
    expect(calls.find((c) => c.table === "crm_lead_activities")?.gtes.performed_at).toBe(
      "2026-11-01T03:00:00.000Z",
    );
    expect(calls.find((c) => c.table === "messages")?.gtes.sent_at).toBe("2026-11-01T03:00:00.000Z");
  });

  it("filters the organization in every query; a foreign or unknown lead is silently absent", async () => {
    const { ctx, calls } = makeCtx({
      crm_leads: leadsOfOrg,
      contacts: [],
      crm_lead_activities: (call) => ({
        data: ((call.ins.lead_id ?? []) as string[]).map((id) => ({
          lead_id: id,
          type: "appointment_scheduled",
          channel: null,
          performed_at: "2026-11-05T15:00:00Z",
        })),
        error: null,
      }),
      conversations,
      messages: [],
    });
    const out = (await crmListLeadEvents.handler(
      { lead_ids: [LEAD_A, LEAD_FOREIGN], since: SINCE },
      ctx,
    )) as { events: Array<{ lead_id: string }> };
    expect(out.events.map((e) => e.lead_id)).toEqual([LEAD_A]);
    for (const c of calls) expect(c.eqs.organization_id, c.table).toBe(ORG);
    expect(calls.find((c) => c.table === "crm_lead_activities")?.ins.lead_id).toEqual([LEAD_A]);
  });

  it("answers an empty list, without more queries, when no lead is of the organization", async () => {
    const { ctx, calls } = makeCtx({ crm_leads: leadsOfOrg });
    const out = await crmListLeadEvents.handler({ lead_ids: [LEAD_FOREIGN], since: SINCE }, ctx);
    expect(out).toEqual({ events: [] });
    expect(calls.map((c) => c.table)).toEqual(["crm_leads"]);
  });

  it("leaves out the leads of a personal contact", async () => {
    const { ctx } = makeCtx({
      crm_leads: leadsOfOrg,
      contacts: [{ id: CONTACT_B }],
      crm_lead_activities: (call) => ({
        data: ((call.ins.lead_id ?? []) as string[]).map((id) => ({
          lead_id: id,
          type: "touch",
          channel: "email",
          performed_at: "2026-11-05T15:00:00Z",
        })),
        error: null,
      }),
      conversations,
      messages: [],
    });
    const out = (await crmListLeadEvents.handler(
      { lead_ids: [LEAD_A, LEAD_B], since: SINCE },
      ctx,
    )) as { events: Array<{ lead_id: string }> };
    expect(out.events.map((e) => e.lead_id)).toEqual([LEAD_A]);
  });

  it("inside an agent turn, reads only the leads of the turn's contact", async () => {
    const { ctx, calls } = makeCtx(
      { crm_leads: leadsOfOrg, contacts: [], crm_lead_activities: [], conversations, messages: [] },
      { contatoDoTurno: CONTACT_A },
    );
    await crmListLeadEvents.handler({ lead_ids: [LEAD_A, LEAD_B], since: SINCE }, ctx);
    expect(calls.find((c) => c.table === "crm_leads")?.eqs.contact_id).toBe(CONTACT_A);
    expect(calls.find((c) => c.table === "conversations")?.ins.contact_id).toEqual([CONTACT_A]);
  });

  it("reads messages page by page until a short page", async () => {
    const full: Rows = Array.from({ length: 1000 }, (_, i) => ({
      conversation_id: CONV_A,
      direction: "inbound",
      status: "received",
      sent_at: new Date(Date.UTC(2026, 10, 2, 12, 0, i)).toISOString(),
      created_at: null,
    }));
    const { ctx, calls } = makeCtx({
      crm_leads: leadsOfOrg,
      contacts: [],
      crm_lead_activities: [],
      conversations,
      messages: (call) => ({
        data:
          call.ranges[0]?.[0] === 0
            ? full
            : [{ conversation_id: CONV_A, direction: "inbound", status: "received", sent_at: "2026-11-09T12:00:00Z", created_at: null }],
        error: null,
      }),
    });
    const out = (await crmListLeadEvents.handler({ lead_ids: [LEAD_A], since: SINCE }, ctx)) as {
      events: Array<{ at: string }>;
    };
    expect(calls.filter((c) => c.table === "messages").map((c) => c.ranges[0])).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(out.events.map((e) => e.at)).toEqual(["2026-11-02T12:00:00.000Z", "2026-11-09T12:00:00.000Z"]);
  });

  it("propagates a database error instead of answering an empty list", async () => {
    const { ctx } = makeCtx({
      crm_leads: leadsOfOrg,
      contacts: [],
      crm_lead_activities: () => ({ data: null, error: { message: "boom" } }),
    });
    await expect(
      crmListLeadEvents.handler({ lead_ids: [LEAD_A], since: SINCE }, ctx),
    ).rejects.toThrow(/boom/);
  });
});
