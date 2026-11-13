/**
 * Berseba: the Bia's call report lands on the lead (Berseba/berseba issue #232). In a Cold Call
 * funnel it moves the card by the Cold Call's rule; anywhere else it only writes the line.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";

const { move, close, modulo } = vi.hoisted(() => ({
  move: vi.fn(),
  close: vi.fn(),
  modulo: vi.fn(),
}));
vi.mock("@/app/api/v1/leads/_handler", () => ({ moveLeadHandler: move }));
vi.mock("@/lib/leads/encerramento", () => ({ encerraDemanda: close }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: modulo }));

const { applyVozReport, textoDaLinha, vozCallEndedSchema, RESULTADO_DA_BIA } =
  await import("./report");

const ORG = "0cc6e9e0-a9b0-42a4-951b-a0cb1e554a48";
const COLD = "0a7bc40c-45a3-47ed-ac0c-684fd8111ed2";
const SALES = "88888888-8888-4888-8888-888888888888";
const LEAD = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const TOKEN = "33333333-3333-4333-8333-333333333333";
const CALL = "44444444-4444-4444-8444-444444444444";
const ST = {
  fila: "a0000000-0000-4000-8000-000000000001",
  naoAtendeu: "a0000000-0000-4000-8000-000000000002",
  reuniao: "a0000000-0000-4000-8000-000000000003",
  followUp: "a0000000-0000-4000-8000-000000000004",
};

type Row = Record<string, unknown>;

const COLD_SETTINGS = { cold_call: { ativo: true, roteiro: "" }, lost_reasons: [] };

function lead(over: Row = {}): Row {
  return {
    id: LEAD,
    organization_id: ORG,
    contact_id: CONTACT,
    pipeline_id: COLD,
    stage_id: ST.fila,
    status: "open",
    created_at: "2026-11-01T10:00:00Z",
    last_activity_at: "2026-11-10T10:00:00Z",
    crm_pipelines: { settings: COLD_SETTINGS },
    ...over,
  };
}

function tables(over: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    crm_leads: [lead()],
    crm_stages: [
      { id: ST.fila, organization_id: ORG, pipeline_id: COLD, slug: "na-fila" },
      { id: ST.naoAtendeu, organization_id: ORG, pipeline_id: COLD, slug: "nao-atendeu" },
      { id: ST.reuniao, organization_id: ORG, pipeline_id: COLD, slug: "reuniao-pedida" },
      { id: ST.followUp, organization_id: ORG, pipeline_id: COLD, slug: "follow-up" },
    ],
    contacts: [
      {
        id: CONTACT,
        organization_id: ORG,
        phone_number: "+5511987654321",
        is_personal: false,
        is_anonymized: false,
        is_merged_into: null,
      },
    ],
    crm_lead_activities: [],
    crm_pipelines: [{ id: COLD, organization_id: ORG, settings: COLD_SETTINGS }],
    ...over,
  };
}

/** Plain rows; filters eq/in/is; `failOn` answers an error for that table, like supabase-js. */
function fakeDb(data: Record<string, Row[]>, failOn?: string, insertError?: string) {
  const writes: Array<{ table: string; op: string; row: Row }> = [];
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const rows = () => {
      if (table === failOn) return { data: null, error: { message: "down" } };
      return { data: (data[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null };
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
      insert: async (row: Row) => {
        writes.push({ table, op: "insert", row });
        return { error: insertError ? { message: insertError } : null };
      },
      update: (row: Row) => {
        writes.push({ table, op: "update", row });
        const chain = { eq: () => chain, then: (r: (v: unknown) => unknown) => r({ error: null }) };
        return chain;
      },
    };
    return query;
  };
  return { supabase: { from: vi.fn(from) } as never, writes };
}

const CTX = { organizationId: ORG, apiTokenId: TOKEN, requestId: "req-1" };

function report(over: Row = {}) {
  return vozCallEndedSchema.parse({
    event: "call.ended",
    call_id: CALL,
    to: "5511987654321",
    lead_ref: { id: LEAD },
    status: "ended",
    outcome: "meeting_booked",
    summary: "Quer uma conversa na terça de manhã.",
    next_step: "Confirmar terça 10h pelo WhatsApp",
    action_plan: "- Confirmar",
    duration_s: 184,
    cost_usd: 0.01,
    ...over,
  });
}

const line = (writes: Array<{ table: string; row: Row }>) =>
  writes.find((w) => w.table === "crm_lead_activities")?.row;

beforeEach(() => {
  move.mockReset().mockResolvedValue({});
  close.mockReset().mockResolvedValue({});
  modulo.mockReset().mockResolvedValue(true);
});

describe("the mapping", () => {
  it("every Voz outcome has a Cold Call result or none", () => {
    expect(RESULTADO_DA_BIA).toEqual({
      meeting_booked: "reuniao",
      interested: "follow_up",
      callback: "follow_up",
      no_answer: "nao_atendeu",
      not_interested: "sem_interesse",
      opted_out: "sem_interesse",
      wrong_number: "numero_errado",
      other: null,
    });
  });

  it("the line names the Bia, her conclusion, the summary and the next step", () => {
    expect(textoDaLinha(report())).toBe(
      "Ligação da Bia (reunião marcada): Quer uma conversa na terça de manhã. Próximo passo: Confirmar terça 10h pelo WhatsApp",
    );
    expect(textoDaLinha(report({ next_step: null, outcome: "other" }))).toBe(
      "Ligação da Bia (ligação feita): Quer uma conversa na terça de manhã.",
    );
    const long = textoDaLinha(report({ summary: "x".repeat(3000) }));
    expect(long.length).toBe(1500);
    expect(long.endsWith("…")).toBe(true);
  });

  it("refuses a body without the contract's fields", () => {
    expect(vozCallEndedSchema.safeParse({ call_id: CALL }).success).toBe(false);
    expect(vozCallEndedSchema.safeParse({ ...report(), outcome: "maybe" }).success).toBe(false);
  });
});

describe("applyVozReport", () => {
  it("Cold Call funnel: moves the card to the result's stage and writes a cold_call_result line", async () => {
    const db = fakeDb(tables());
    const r = await applyVozReport(db.supabase, CTX, report());
    expect(r).toEqual({ outcome: "applied", leadId: LEAD, resultado: "reuniao" });
    expect(move).toHaveBeenCalledWith(
      db.supabase,
      expect.objectContaining({ organization_id: ORG, actor: { type: "api_token", id: TOKEN } }),
      LEAD,
      { to_stage_id: ST.reuniao, reason: "Ligação da Bia: Pediu reunião" },
    );
    expect(line(db.writes)).toMatchObject({
      organization_id: ORG,
      lead_id: LEAD,
      contact_id: CONTACT,
      type: "cold_call_result",
      source_module: "voz",
      source_id: CALL,
      actor_kind: "system",
      payload: { resultado: "reuniao", voz_outcome: "meeting_booked", duracao_s: 184 },
    });
  });

  it("a card already in the stage is not moved, the line is still written", async () => {
    const db = fakeDb(tables({ crm_leads: [lead({ stage_id: ST.reuniao })] }));
    expect((await applyVozReport(db.supabase, CTX, report())).outcome).toBe("applied");
    expect(move).not.toHaveBeenCalled();
    expect(line(db.writes)).toBeDefined();
  });

  it("a lost result closes the lead with the Cold Call reason, listing the reasons first", async () => {
    const db = fakeDb(tables());
    const r = await applyVozReport(db.supabase, CTX, report({ outcome: "opted_out" }));
    expect(r.resultado).toBe("sem_interesse");
    expect(close).toHaveBeenCalledWith(db.supabase, expect.anything(), {
      leadId: LEAD,
      desfecho: "lost",
      motivo: "Não tem interesse",
    });
    const reasons = db.writes.find((w) => w.table === "crm_pipelines");
    expect(reasons?.row.settings).toMatchObject({
      lost_reasons: expect.arrayContaining(["Não tem interesse"]),
    });
  });

  it("a funnel that already lists the reasons is not rewritten", async () => {
    const settings = {
      cold_call: { ativo: true, roteiro: "" },
      lost_reasons: ["Não tem interesse", "Número errado", "Tirado da fila"],
    };
    const db = fakeDb(tables({ crm_leads: [lead({ crm_pipelines: { settings } })] }));
    await applyVozReport(db.supabase, CTX, report({ outcome: "wrong_number" }));
    expect(db.writes.some((w) => w.table === "crm_pipelines")).toBe(false);
    expect(close).toHaveBeenCalledWith(
      db.supabase,
      expect.anything(),
      expect.objectContaining({ motivo: "Número errado" }),
    );
  });

  it("another funnel: no move, a voz_call_report line", async () => {
    const db = fakeDb(
      tables({ crm_leads: [lead({ pipeline_id: SALES, crm_pipelines: { settings: {} } })] }),
    );
    const r = await applyVozReport(db.supabase, CTX, report());
    expect(r).toEqual({ outcome: "applied", leadId: LEAD, resultado: null });
    expect(move).not.toHaveBeenCalled();
    expect(line(db.writes)).toMatchObject({
      type: "voz_call_report",
      payload: { voz_outcome: "meeting_booked" },
    });
  });

  it("'other' in a Cold Call funnel: only the line", async () => {
    const db = fakeDb(tables());
    const r = await applyVozReport(
      db.supabase,
      CTX,
      report({ outcome: "other", duration_s: undefined }),
    );
    expect(r.resultado).toBeNull();
    expect(move).not.toHaveBeenCalled();
    expect(line(db.writes)?.payload).toEqual({ voz_outcome: "other" });
  });

  it("a closed lead is never reopened: only the line", async () => {
    const db = fakeDb(tables({ crm_leads: [lead({ status: "lost" })] }));
    expect((await applyVozReport(db.supabase, CTX, report())).outcome).toBe("applied");
    expect(move).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("the line is written before the card moves", async () => {
    const order: string[] = [];
    const db = fakeDb(tables());
    const realFrom = (db.supabase as { from: (t: string) => unknown }).from;
    (db.supabase as { from: unknown }).from = vi.fn((t: string) => {
      const q = realFrom(t) as { insert?: (r: Row) => unknown };
      if (t === "crm_lead_activities" && q.insert) {
        const insert = q.insert;
        q.insert = (r: Row) => (order.push("line"), insert(r));
      }
      return q;
    });
    move.mockImplementationOnce(async () => void order.push("move"));
    await applyVozReport(db.supabase, CTX, report());
    expect(order).toEqual(["line", "move"]);
  });

  it("the Cold Call module off: only the line, the card stays", async () => {
    modulo.mockResolvedValue(false);
    const db = fakeDb(tables());
    const r = await applyVozReport(db.supabase, CTX, report());
    expect(r).toEqual({ outcome: "applied", leadId: LEAD, resultado: null });
    expect(move).not.toHaveBeenCalled();
    expect(line(db.writes)).toMatchObject({ type: "voz_call_report" });
  });

  it("a retry finds the line on any card of the organization, and writes nothing", async () => {
    const OTHER = "77777777-7777-4777-8777-777777777777";
    const db = fakeDb(
      tables({
        crm_lead_activities: [
          { id: "a1", organization_id: ORG, lead_id: OTHER, source_module: "voz", source_id: CALL },
        ],
      }),
    );
    expect(await applyVozReport(db.supabase, CTX, report({ lead_ref: null }))).toEqual({
      outcome: "already_applied",
      leadId: OTHER,
    });
    expect(db.writes).toEqual([]);
    expect(move).not.toHaveBeenCalled();
  });

  it("a second delivery of the same call writes nothing", async () => {
    const db = fakeDb(
      tables({
        crm_lead_activities: [
          { id: "a1", organization_id: ORG, lead_id: LEAD, source_module: "voz", source_id: CALL },
        ],
      }),
    );
    expect(await applyVozReport(db.supabase, CTX, report())).toEqual({
      outcome: "already_applied",
      leadId: LEAD,
    });
    expect(db.writes).toEqual([]);
    expect(move).not.toHaveBeenCalled();
  });

  it("without lead_ref (or with a stale id), the contact's open lead by phone", async () => {
    for (const ref of [
      null,
      { id: "not-a-uuid" },
      { id: "55555555-5555-4555-8555-555555555555" },
    ]) {
      const db = fakeDb(tables());
      const r = await applyVozReport(
        db.supabase,
        CTX,
        report({ lead_ref: ref, to: "(11) 98765-4321" }),
      );
      expect(r.leadId).toBe(LEAD);
    }
  });

  it("no contact, an excluded contact, no lead, two tied leads: an outcome, nothing written", async () => {
    const noRef = { lead_ref: null };
    const none = fakeDb(tables({ contacts: [] }));
    expect((await applyVozReport(none.supabase, CTX, report(noRef))).outcome).toBe("no_contact");
    const badPhone = fakeDb(tables());
    expect(
      (await applyVozReport(badPhone.supabase, CTX, report({ ...noRef, to: "12345678" }))).outcome,
    ).toBe("no_contact");
    const personal = fakeDb(
      tables({ contacts: [{ ...tables().contacts![0], is_personal: true }] }),
    );
    expect((await applyVozReport(personal.supabase, CTX, report(noRef))).outcome).toBe(
      "no_contact",
    );
    const noLead = fakeDb(tables({ crm_leads: [] }));
    expect((await applyVozReport(noLead.supabase, CTX, report(noRef))).outcome).toBe("no_lead");
    const tied = fakeDb(
      tables({
        crm_leads: [
          lead(),
          lead({ id: "66666666-6666-4666-8666-666666666666", pipeline_id: SALES }),
        ],
      }),
    );
    expect((await applyVozReport(tied.supabase, CTX, report(noRef))).outcome).toBe("no_lead");
    for (const db of [none, noLead, tied]) expect(db.writes).toEqual([]);
  });

  it("a missing stage or a lead rule refusal still writes the line, as 'refused'", async () => {
    const noStage = fakeDb(tables({ crm_stages: [] }));
    const r = await applyVozReport(noStage.supabase, CTX, report());
    expect(r).toMatchObject({ outcome: "refused", code: "stage_missing" });
    expect(line(noStage.writes)).toBeDefined();

    move.mockRejectedValueOnce(
      new ApiError(422, "required_fields_missing", undefined, "req-1", "Falta campo"),
    );
    const rule = fakeDb(tables());
    expect(await applyVozReport(rule.supabase, CTX, report())).toMatchObject({
      outcome: "refused",
      code: "required_fields_missing",
    });
    expect(line(rule.writes)).toBeDefined();
  });

  it("after the line, any move failure is reported as refused: the line stays, nothing is retried", async () => {
    const cases: Array<[unknown, string]> = [
      [
        new ApiError(409, "lead_stage_changed_concurrent", undefined, "req-1", "x"),
        "lead_stage_changed_concurrent",
      ],
      [new ApiError(500, "internal_error", undefined, "req-1", "x"), "internal_error"],
      [new Error("boom"), "move_failed"],
      ["weird", "move_failed"],
    ];
    for (const [err, code] of cases) {
      move.mockRejectedValueOnce(err);
      const db = fakeDb(tables());
      expect(await applyVozReport(db.supabase, CTX, report())).toMatchObject({
        outcome: "refused",
        code,
      });
      expect(line(db.writes)).toBeDefined();
    }
    const stagesDown = fakeDb(tables(), "crm_stages");
    expect(await applyVozReport(stagesDown.supabase, CTX, report())).toMatchObject({
      outcome: "refused",
      code: "stage_read_failed",
    });
    expect(line(stagesDown.writes)).toBeDefined();
  });

  it("a dead database before the line is unavailable: nothing written, Voz retries", async () => {
    for (const table of ["crm_leads", "crm_lead_activities"]) {
      const db = fakeDb(tables(), table);
      expect((await applyVozReport(db.supabase, CTX, report())).outcome).toBe("unavailable");
      expect(db.writes).toEqual([]);
    }
    const contactsDown = fakeDb(tables(), "contacts");
    expect(
      (await applyVozReport(contactsDown.supabase, CTX, report({ lead_ref: null }))).outcome,
    ).toBe("unavailable");
    const lineDown = fakeDb(tables(), undefined, "insert failed");
    expect((await applyVozReport(lineDown.supabase, CTX, report())).outcome).toBe("unavailable");
    expect(move).not.toHaveBeenCalled();
  });
});
