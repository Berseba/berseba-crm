/**
 * Berseba: an evaluation booked in Mirae moves the card ("Avaliação agendada" = the stage with
 * `agent_stage_hint = 'negotiating'`) through the same function as the `update_lead_state` mirror.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sync } = vi.hoisted(() => ({ sync: vi.fn() }));
vi.mock("@/lib/leads/agent-stage-sync", () => ({ sincronizaEstagioDoAgente: sync }));

const { moveCardOnEvaluationBooked } = await import("./evaluation-stage");

const ORG = "0cc6e9e0-a9b0-42a4-951b-a0cb1e554a48";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const AGENT = "bdf21a9d-aef3-4a60-9ab5-feff3a97d305";
const VERSION = "4ebb20fc-26c4-48bb-ab03-9fb50076df2c";
const FUNNEL = "0a7bc40c-45a3-47ed-ac0c-684fd8111ed2";
const JOB = "33333333-3333-4333-8333-333333333333";

type Row = Record<string, unknown>;

/** Tables as plain rows; records every write. Each select answers its first matching row. */
function fakeDb(tables: Record<string, Row[]>) {
  const writes: Array<{ table: string; op: string; row: Row; options?: unknown }> = [];
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const query = {
      select: () => query,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return query;
      },
      maybeSingle: async () => ({
        data: (tables[table] ?? []).find((r) => filters.every(([c, v]) => r[c] === v)) ?? null,
        error: null,
      }),
      upsert: async (row: Row, options: unknown) => {
        writes.push({ table, op: "upsert", row, options });
        return { error: null };
      },
      insert: async (row: Row) => {
        writes.push({ table, op: "insert", row });
        return { error: null };
      },
    };
    return query;
  };
  return { supabase: { from: vi.fn(from) }, writes };
}

function ctx(supabase: unknown, over: Row = {}) {
  return {
    organizationId: ORG,
    role: "ai_operator",
    actor: { type: "ai_agent", id: AGENT, agent_id: AGENT, role: "ai_operator" },
    apiTokenId: "t",
    requestId: "r",
    sourceJobId: JOB,
    contatoDoTurno: CONTACT,
    supabase,
    ...over,
  } as never;
}

const PUBLISHED = {
  ai_agents: [{ id: AGENT, organization_id: ORG, published_version_id: VERSION }],
  ai_agent_versions: [{ id: VERSION, organization_id: ORG, pipeline_ids: [FUNNEL] }],
};

beforeEach(() => {
  sync.mockReset().mockResolvedValue({ moveu: true, motivo: "movido", leadId: "lead-1" });
});

describe("moveCardOnEvaluationBooked", () => {
  it("advances the agent's funnel to negotiating and moves the card within the published scope", async () => {
    const { supabase, writes } = fakeDb({
      ...PUBLISHED,
      lead_state: [{ organization_id: ORG, contact_id: CONTACT, stage: "qualified" }],
    });
    const r = await moveCardOnEvaluationBooked(ctx(supabase));
    expect(r).toEqual({ harness: "advanced", card: "movido" });
    expect(writes).toEqual([
      {
        table: "lead_state",
        op: "upsert",
        row: expect.objectContaining({
          organization_id: ORG,
          contact_id: CONTACT,
          stage: "negotiating",
        }),
        options: { onConflict: "organization_id,contact_id" },
      },
      {
        table: "lead_state_transitions",
        op: "insert",
        row: expect.objectContaining({
          organization_id: ORG,
          contact_id: CONTACT,
          job_id: JOB,
          from_stage: "qualified",
          to_stage: "negotiating",
        }),
      },
    ]);
    expect(sync).toHaveBeenCalledWith(supabase, {
      organizationId: ORG,
      contactId: CONTACT,
      passo: "negotiating",
      escopoDeFunis: [FUNNEL],
    });
  });

  it("a contact with no harness row starts from new", async () => {
    const { supabase, writes } = fakeDb(PUBLISHED);
    await moveCardOnEvaluationBooked(ctx(supabase));
    expect(writes[1]!.row).toMatchObject({ from_stage: "new", to_stage: "negotiating" });
  });

  it.each(["negotiating", "won", "lost"])(
    "never moves the agent's funnel back from %s",
    async (stage) => {
      const { supabase, writes } = fakeDb({
        ...PUBLISHED,
        lead_state: [{ organization_id: ORG, contact_id: CONTACT, stage }],
      });
      const r = await moveCardOnEvaluationBooked(ctx(supabase));
      expect(r.harness).toBe("already_there");
      expect(writes).toEqual([]);
    },
  );

  it("without a published version the scope is empty (none), never every funnel", async () => {
    const { supabase } = fakeDb({});
    await moveCardOnEvaluationBooked(ctx(supabase));
    expect(sync.mock.calls[0]![1]).toMatchObject({ escopoDeFunis: [] });
  });

  it("reads the scope of this organization's agent only", async () => {
    const { supabase } = fakeDb({
      ai_agents: [{ id: AGENT, organization_id: "another-org", published_version_id: VERSION }],
      ai_agent_versions: PUBLISHED.ai_agent_versions,
    });
    await moveCardOnEvaluationBooked(ctx(supabase));
    expect(sync.mock.calls[0]![1]).toMatchObject({ escopoDeFunis: [] });
  });

  it("a card that does not move is reported, and nothing throws", async () => {
    sync.mockResolvedValueOnce({ moveu: false, motivo: "fora_do_escopo" });
    const { supabase } = fakeDb(PUBLISHED);
    expect(await moveCardOnEvaluationBooked(ctx(supabase))).toEqual({
      harness: "advanced",
      card: "fora_do_escopo",
    });
    sync.mockRejectedValueOnce(new Error("db down"));
    expect(await moveCardOnEvaluationBooked(ctx(supabase))).toEqual({
      harness: "failed",
      card: "erro",
    });
  });

  it("without a contact of the turn, does nothing", async () => {
    const { supabase, writes } = fakeDb(PUBLISHED);
    expect(
      await moveCardOnEvaluationBooked(ctx(supabase, { contatoDoTurno: undefined })),
    ).toMatchObject({
      card: "sem_contato_do_turno",
    });
    expect(writes).toEqual([]);
    expect(sync).not.toHaveBeenCalled();
  });
});
