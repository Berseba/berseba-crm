/**
 * Berseba: a Mirae milestone moves the card through `moveLeadHandler` (Mirae ADR-073, ponte ②).
 * Fiore's "Novos alunos" ids, so a reader can match them with the production funnel.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";

const { move, audit } = vi.hoisted(() => ({ move: vi.fn(), audit: vi.fn() }));
vi.mock("@/app/api/v1/leads/_handler", () => ({ moveLeadHandler: move }));
vi.mock("@/lib/audit", () => ({ audit }));

const { applyMiraeMilestone, miraeMilestoneSchema } = await import("./milestone");

const ORG = "0cc6e9e0-a9b0-42a4-951b-a0cb1e554a48";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const FUNNEL = "0a7bc40c-45a3-47ed-ac0c-684fd8111ed2";
const OTHER_FUNNEL = "88888888-8888-4888-8888-888888888888";
const BOOKED = "482f1e49-66e3-4728-8ea7-92c26d1528eb";
const MISSED = "040d65d2-6b51-4bc0-a74a-bb1a308e1c2d";
const ATTENDED = "ad205839-69f3-43e1-87de-21172b952522";
const ENROLLED = "51b9349e-6fba-4170-b8aa-66650a261dc1";
const LOST = "e1f03635-aa03-492f-808d-8efda1d04da2";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const TOKEN = "33333333-3333-4333-8333-333333333333";

type Row = Record<string, unknown>;

const STAGES: Row[] = [
  {
    id: BOOKED,
    organization_id: ORG,
    pipeline_id: FUNNEL,
    is_won: false,
    is_lost: false,
    is_archived: false,
  },
  {
    id: MISSED,
    organization_id: ORG,
    pipeline_id: FUNNEL,
    is_won: false,
    is_lost: false,
    is_archived: false,
  },
  {
    id: ATTENDED,
    organization_id: ORG,
    pipeline_id: FUNNEL,
    is_won: false,
    is_lost: false,
    is_archived: false,
  },
  {
    id: ENROLLED,
    organization_id: ORG,
    pipeline_id: FUNNEL,
    is_won: true,
    is_lost: false,
    is_archived: false,
  },
  {
    id: LOST,
    organization_id: ORG,
    pipeline_id: FUNNEL,
    is_won: false,
    is_lost: true,
    is_archived: false,
  },
];

const CONTACTS: Row[] = [
  {
    id: CONTACT,
    organization_id: ORG,
    phone_number: "+5511987654321",
    is_personal: false,
    is_anonymized: false,
    is_merged_into: null,
  },
];

function lead(over: Row = {}): Row {
  return {
    id: "lead-1",
    organization_id: ORG,
    contact_id: CONTACT,
    pipeline_id: FUNNEL,
    stage_id: BOOKED,
    status: "open",
    created_at: "2026-10-20T10:00:00Z",
    last_activity_at: "2026-10-30T10:00:00Z",
    ...over,
  };
}

/**
 * Tables as plain rows. Filters `eq`/`in`/`is`; ends on `maybeSingle`, `limit` or `await`.
 * `failOn` makes every read of that table answer an error, like supabase-js does (no throw).
 */
function fakeDb(tables: Record<string, Row[]>, failOn?: string) {
  const writes: Array<{ table: string; op: string; row: Row }> = [];
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const rows = () => {
      if (table === failOn) return { data: null, error: { message: "down" } };
      return { data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null };
    };
    const query = {
      select: () => query,
      eq: (col: string, val: unknown) => (filters.push((r) => r[col] === val), query),
      in: (col: string, vals: unknown[]) => (filters.push((r) => vals.includes(r[col])), query),
      is: (col: string, val: unknown) => (filters.push((r) => (r[col] ?? null) === val), query),
      limit: async () => rows(),
      maybeSingle: async () => {
        const r = rows();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      then: (resolve: (v: unknown) => unknown) => resolve(rows()),
      upsert: async (row: Row) => (writes.push({ table, op: "upsert", row }), { error: null }),
      insert: async (row: Row) => (writes.push({ table, op: "insert", row }), { error: null }),
    };
    return query;
  };
  return { supabase: { from: vi.fn(from) } as never, writes };
}

const CTX = { organizationId: ORG, apiTokenId: TOKEN, requestId: "req-1" };

function input(over: Row = {}) {
  return miraeMilestoneSchema.parse({
    milestone: "attended",
    phone: "(11) 98765-4321",
    pipeline_id: FUNNEL,
    stage_id: ATTENDED,
    ...over,
  });
}

beforeEach(() => {
  move.mockReset().mockResolvedValue({});
  audit.mockReset().mockResolvedValue(undefined);
});

describe("applyMiraeMilestone", () => {
  it("moves the open card through the lead rule, as the token, and aligns the agent's funnel", async () => {
    const { supabase, writes } = fakeDb({
      crm_stages: STAGES,
      contacts: CONTACTS,
      crm_leads: [lead()],
      lead_state: [{ organization_id: ORG, contact_id: CONTACT, stage: "qualified" }],
    });
    const r = await applyMiraeMilestone(supabase, CTX, input());
    expect(r).toEqual({ outcome: "moved", leadId: "lead-1", harness: "advanced" });
    expect(move).toHaveBeenCalledWith(
      supabase,
      { organization_id: ORG, actor: { type: "api_token", id: TOKEN }, requestId: "req-1" },
      "lead-1",
      { to_stage_id: ATTENDED, reason: "Mirae: presença na avaliação" },
    );
    expect(writes.find((w) => w.table === "lead_state")?.row).toMatchObject({
      stage: "negotiating",
    });
  });

  it("finds the contact stored with the 9th digit from a Mirae phone without it", async () => {
    const { supabase } = fakeDb({ crm_stages: STAGES, contacts: CONTACTS, crm_leads: [lead()] });
    const r = await applyMiraeMilestone(supabase, CTX, input({ phone: "11 8765-4321" }));
    expect(r.outcome).toBe("moved");
  });

  it("a missed evaluation goes to Faltou, and a later presence moves on to Avaliação feita", async () => {
    const db = fakeDb({ crm_stages: STAGES, contacts: CONTACTS, crm_leads: [lead()] });
    await applyMiraeMilestone(db.supabase, CTX, input({ milestone: "missed", stage_id: MISSED }));
    expect(move.mock.calls[0]![3]).toEqual({
      to_stage_id: MISSED,
      reason: "Mirae: falta na avaliação",
    });
    const after = fakeDb({
      crm_stages: STAGES,
      contacts: CONTACTS,
      crm_leads: [lead({ stage_id: MISSED })],
    });
    const r = await applyMiraeMilestone(after.supabase, CTX, input());
    expect(r.outcome).toBe("moved");
  });

  it("a card already in the stage is not written again (a retried call is a no-op)", async () => {
    const { supabase } = fakeDb({
      crm_stages: STAGES,
      contacts: CONTACTS,
      crm_leads: [lead({ stage_id: ATTENDED })],
      lead_state: [{ organization_id: ORG, contact_id: CONTACT, stage: "negotiating" }],
    });
    const r = await applyMiraeMilestone(supabase, CTX, input());
    expect(r).toEqual({ outcome: "already_there", leadId: "lead-1", harness: "already_there" });
    expect(move).not.toHaveBeenCalled();
  });

  it("an enrollment reopens the latest lost card as won, and closes the agent's funnel as won", async () => {
    const { supabase, writes } = fakeDb({
      crm_stages: STAGES,
      contacts: CONTACTS,
      crm_leads: [
        lead({ id: "old", status: "lost", stage_id: LOST, created_at: "2026-08-01T00:00:00Z" }),
        lead({ id: "new", status: "lost", stage_id: LOST, created_at: "2026-10-01T00:00:00Z" }),
      ],
      lead_state: [{ organization_id: ORG, contact_id: CONTACT, stage: "lost" }],
    });
    const r = await applyMiraeMilestone(
      supabase,
      CTX,
      input({ milestone: "enrolled", stage_id: ENROLLED }),
    );
    expect(r).toMatchObject({ outcome: "moved", leadId: "new", harness: "advanced" });
    expect(move.mock.calls[0]![3]).toEqual({ to_stage_id: ENROLLED, reason: "Mirae: matrícula" });
    expect(writes.find((w) => w.table === "lead_state")?.row).toMatchObject({ stage: "won" });
  });

  it("only an enrollment reopens: a presence on a lost card leaves it, and a won card stays won", async () => {
    const lostOnly = fakeDb({
      crm_stages: STAGES,
      contacts: CONTACTS,
      crm_leads: [lead({ status: "lost", stage_id: LOST })],
    });
    expect((await applyMiraeMilestone(lostOnly.supabase, CTX, input())).outcome).toBe(
      "lead_closed",
    );
    const won = fakeDb({
      crm_stages: STAGES,
      contacts: CONTACTS,
      crm_leads: [
        lead({ status: "won", stage_id: ENROLLED }),
        lead({ id: "x", status: "lost", stage_id: LOST }),
      ],
    });
    const r = await applyMiraeMilestone(
      won.supabase,
      CTX,
      input({ milestone: "enrolled", stage_id: ENROLLED }),
    );
    expect(r.outcome).toBe("lead_closed");
    expect(move).not.toHaveBeenCalled();
  });

  it("refuses a map that does not fit: another funnel, another organization, a won stage for a visit, an open one for an enrollment, the lost stage", async () => {
    const stages = [
      ...STAGES,
      {
        id: "other-org-stage",
        organization_id: OTHER_ORG,
        pipeline_id: FUNNEL,
        is_won: false,
        is_lost: false,
        is_archived: false,
      },
    ];
    const { supabase } = fakeDb({ crm_stages: stages, contacts: CONTACTS, crm_leads: [lead()] });
    const cases: Array<[Row, string]> = [
      [{ pipeline_id: OTHER_FUNNEL }, "stage_not_in_pipeline"],
      [{ stage_id: "11111111-1111-4111-8111-111111111111" }, "stage_not_in_pipeline"],
      [{ stage_id: ENROLLED }, "stage_does_not_fit_milestone"],
      [{ milestone: "enrolled", stage_id: ATTENDED }, "stage_does_not_fit_milestone"],
      [{ milestone: "missed", stage_id: LOST }, "stage_does_not_fit_milestone"],
    ];
    for (const [over, code] of cases) {
      expect(await applyMiraeMilestone(supabase, CTX, input(over))).toEqual({
        outcome: "invalid_stage",
        code,
      });
    }
    // The stage of another organization is never even found (the read filters by the token's org).
    const foreign = fakeDb({ crm_stages: stages, contacts: CONTACTS, crm_leads: [lead()] });
    const r = await applyMiraeMilestone(
      foreign.supabase,
      CTX,
      miraeMilestoneSchema.parse({ ...input(), stage_id: "99999999-0000-4000-8000-000000000000" }),
    );
    expect(r.outcome).toBe("invalid_stage");
    expect(move).not.toHaveBeenCalled();
  });

  it("never moves a card of a personal contact, nor guesses without a contact or between two tied cards", async () => {
    const personal = fakeDb({
      crm_stages: STAGES,
      contacts: [{ ...CONTACTS[0]!, is_personal: true }],
      crm_leads: [lead()],
    });
    expect((await applyMiraeMilestone(personal.supabase, CTX, input())).outcome).toBe(
      "contact_excluded",
    );
    const nobody = fakeDb({ crm_stages: STAGES, contacts: [], crm_leads: [] });
    expect((await applyMiraeMilestone(nobody.supabase, CTX, input())).outcome).toBe("no_contact");
    const noLead = fakeDb({ crm_stages: STAGES, contacts: CONTACTS, crm_leads: [] });
    expect((await applyMiraeMilestone(noLead.supabase, CTX, input())).outcome).toBe("no_open_lead");
    const tied = fakeDb({
      crm_stages: STAGES,
      contacts: CONTACTS,
      crm_leads: [lead({ id: "a" }), lead({ id: "b" })],
    });
    expect((await applyMiraeMilestone(tied.supabase, CTX, input())).outcome).toBe("ambiguous");
    expect(move).not.toHaveBeenCalled();
  });

  it("a database that does not answer is `unavailable` (retry), never `no_contact`", async () => {
    for (const table of ["crm_stages", "contacts", "crm_leads"]) {
      const { supabase } = fakeDb(
        { crm_stages: STAGES, contacts: CONTACTS, crm_leads: [lead()] },
        table,
      );
      expect((await applyMiraeMilestone(supabase, CTX, input())).outcome).toBe("unavailable");
    }
  });

  it("the lead rule's refusal comes back as `refused` with its code; a concurrent edit as `conflict`", async () => {
    const db = () =>
      fakeDb({ crm_stages: STAGES, contacts: CONTACTS, crm_leads: [lead()] }).supabase;
    move.mockRejectedValueOnce(
      new ApiError(422, "required_fields_missing", undefined, "req-1", "Preencha os campos"),
    );
    expect(await applyMiraeMilestone(db(), CTX, input())).toEqual({
      outcome: "refused",
      leadId: "lead-1",
      code: "required_fields_missing",
      detail: "Preencha os campos",
    });
    move.mockRejectedValueOnce(
      new ApiError(409, "lead_stage_changed_concurrent", undefined, "req-1"),
    );
    expect((await applyMiraeMilestone(db(), CTX, input())).outcome).toBe("conflict");
    move.mockRejectedValueOnce(new ApiError(500, "internal_error", undefined, "req-1"));
    expect((await applyMiraeMilestone(db(), CTX, input())).outcome).toBe("unavailable");
  });
});

describe("applyMiraeMilestone, ordering and the agent's funnel", () => {
  it("a read older than the card's last stage change is `stale`: nothing moves, nothing is written", async () => {
    const tables = () => ({
      crm_stages: STAGES,
      contacts: CONTACTS,
      crm_leads: [lead({ stage_changed_at: "2026-11-03T12:00:00Z" })],
      lead_state: [{ organization_id: ORG, contact_id: CONTACT, stage: "qualified" }],
    });
    const old = fakeDb(tables());
    const r = await applyMiraeMilestone(
      old.supabase,
      CTX,
      input({ as_of: "2026-11-03T11:59:00Z" }),
    );
    expect(r).toEqual({ outcome: "stale", leadId: "lead-1" });
    expect(move).not.toHaveBeenCalled();
    expect(old.writes).toEqual([]);

    const fresh = fakeDb(tables());
    const later = await applyMiraeMilestone(
      fresh.supabase,
      CTX,
      input({ as_of: "2026-11-03T12:00:05Z" }),
    );
    expect(later.outcome).toBe("moved");
  });

  it("an old read for a card already in the stage still aligns the agent's funnel", async () => {
    const { supabase, writes } = fakeDb({
      crm_stages: STAGES,
      contacts: CONTACTS,
      crm_leads: [lead({ stage_id: ATTENDED, stage_changed_at: "2026-11-03T12:00:00Z" })],
      lead_state: [{ organization_id: ORG, contact_id: CONTACT, stage: "qualified" }],
    });
    const r = await applyMiraeMilestone(supabase, CTX, input({ as_of: "2026-11-03T11:00:00Z" }));
    expect(r).toMatchObject({ outcome: "already_there", harness: "advanced" });
    expect(writes.some((w) => w.table === "lead_state")).toBe(true);
  });

  it("a funnel that could not be written is `unavailable`, so the queue retries", async () => {
    const { supabase } = fakeDb(
      { crm_stages: STAGES, contacts: CONTACTS, crm_leads: [lead()] },
      "lead_state",
    );
    const r = await applyMiraeMilestone(supabase, CTX, input());
    expect(r).toMatchObject({
      outcome: "unavailable",
      leadId: "lead-1",
      code: "agent_funnel_not_written",
    });
    expect(move).toHaveBeenCalledOnce();
  });

  it("a funnel step with no card move is audited as the token; a move is left to the lead rule", async () => {
    const still = fakeDb({
      crm_stages: STAGES,
      contacts: CONTACTS,
      crm_leads: [lead({ stage_id: ATTENDED })],
      lead_state: [{ organization_id: ORG, contact_id: CONTACT, stage: "qualified" }],
    });
    await applyMiraeMilestone(still.supabase, CTX, input());
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "mirae.milestone_applied",
        actorUserId: null,
        actorApiTokenId: TOKEN,
        organizationId: ORG,
        resourceId: "lead-1",
        metadata: expect.objectContaining({ milestone: "attended", agent_step: "negotiating" }),
      }),
    );
    audit.mockClear();
    const moving = fakeDb({ crm_stages: STAGES, contacts: CONTACTS, crm_leads: [lead()] });
    await applyMiraeMilestone(moving.supabase, CTX, input());
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("miraeMilestoneSchema", () => {
  it("accepts the four milestones and refuses anything else, including extra keys", () => {
    for (const milestone of ["evaluation_booked", "attended", "missed", "enrolled"]) {
      expect(miraeMilestoneSchema.safeParse({ ...input(), milestone }).success).toBe(true);
    }
    expect(miraeMilestoneSchema.safeParse({ ...input(), milestone: "absent" }).success).toBe(false);
    expect(miraeMilestoneSchema.safeParse({ ...input(), organization_id: ORG }).success).toBe(
      false,
    );
    expect(miraeMilestoneSchema.safeParse({ ...input(), stage_id: "Faltou" }).success).toBe(false);
  });
});
