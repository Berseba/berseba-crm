import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

import { POST } from "./route";

/**
 * POST /api/v1/leads/[id]/touches — "Registrar toque" (Berseba, migration 9005).
 *
 * What the screen cannot show and therefore lives here: the organization comes
 * from the session (another org's lead is a 404 and nothing is written), the
 * note never reaches the audit log, and a failed insert is an error, because
 * the timeline line is the whole mutation.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
const LEAD = "11111111-1111-4111-8111-111111111111";
const CONTACT = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";

type Row = Record<string, unknown>;

/** A PostgREST double that filters for real and records every insert. */
function fakeDb(leads: Row[], insertError: string | null = null) {
  const inserts: { table: string; row: Row }[] = [];
  const from = (table: string) => {
    let rows = table === "crm_leads" ? [...leads] : [];
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((r) => r[column] === value);
        return query;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      insert: async (row: Row) => {
        inserts.push({ table, row });
        return { error: insertError ? { message: insertError } : null };
      },
    };
    return query;
  };
  return { from, inserts };
}

function post(body: unknown, leadId = LEAD) {
  const req = new NextRequest(`http://localhost/api/v1/leads/${leadId}/touches`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  return POST(req, { params: Promise.resolve({ id: leadId }) });
}

let db: ReturnType<typeof fakeDb>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG },
    user: { id: USER, idioma: "pt-BR" },
  } as never);
  db = fakeDb([{ id: LEAD, organization_id: ORG, contact_id: CONTACT }]);
  vi.mocked(createClient).mockResolvedValue(db as never);
});

describe("POST /api/v1/leads/[id]/touches", () => {
  it("writes one `touch` line with the channel in the payload and the note in the reason", async () => {
    const res = await post({ channel: "email", note: "  Mandei a proposta  " });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ data: { channel: "email" } });
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).toEqual({
      table: "crm_lead_activities",
      row: expect.objectContaining({
        organization_id: ORG,
        lead_id: LEAD,
        contact_id: CONTACT,
        type: "touch",
        source_module: "crm",
        actor_kind: "user",
        performed_by_user_id: USER,
        reason: "E-mail: Mandei a proposta",
        payload: { channel: "email" },
      }),
    });
  });

  it("without a note the reason is the channel alone", async () => {
    const res = await post({ channel: "call", note: "   " });
    expect(res.status).toBe(201);
    expect(db.inserts[0]!.row).toMatchObject({ reason: "Telefonema", payload: { channel: "call" } });
  });

  it("audits the channel and never the note", async () => {
    await post({ channel: "linkedin", note: "Falei com a Ana, diretora" });
    expect(audit).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(audit).mock.calls[0]![0];
    expect(entry).toMatchObject({
      action: "lead.touch_recorded",
      organizationId: ORG,
      resourceId: LEAD,
      metadata: { channel: "linkedin", has_note: true },
    });
    expect(JSON.stringify(entry)).not.toContain("Ana");
  });

  it.each([
    ["an unknown channel", { channel: "sms" }],
    ["no channel", { note: "oi" }],
    ["an extra field", { channel: "email", organization_id: OTHER_ORG }],
    ["a note over 500 characters", { channel: "email", note: "x".repeat(501) }],
  ])("refuses %s with 422 and writes nothing", async (_, body) => {
    const res = await post(body);
    expect(res.status).toBe(422);
    expect(db.inserts).toHaveLength(0);
  });

  it("another organization's lead is a 404 and nothing is written", async () => {
    db = fakeDb([{ id: LEAD, organization_id: OTHER_ORG, contact_id: CONTACT }]);
    vi.mocked(createClient).mockResolvedValue(db as never);

    const res = await post({ channel: "whatsapp" });
    expect(res.status).toBe(404);
    expect(db.inserts).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("a malformed lead id is a 404 before the database is asked", async () => {
    const res = await post({ channel: "whatsapp" }, "not-a-uuid");
    expect(res.status).toBe(404);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("a failed insert answers 500 and is not audited", async () => {
    db = fakeDb([{ id: LEAD, organization_id: ORG, contact_id: CONTACT }], "boom");
    vi.mocked(createClient).mockResolvedValue(db as never);

    const res = await post({ channel: "whatsapp" });
    expect(res.status).toBe(500);
    expect(audit).not.toHaveBeenCalled();
  });

  it("below `agent` the role gate answers and nothing is read", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: { code: "forbidden" } }, { status: 403 }),
    } as never);
    const res = await post({ channel: "email" });
    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("agent", expect.anything());
    expect(createClient).not.toHaveBeenCalled();
  });

  it("the temporary support session cannot write", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValueOnce(
      NextResponse.json({ error: { code: "support_read_only" } }, { status: 403 }) as never,
    );
    const res = await post({ channel: "email" });
    expect(res.status).toBe(403);
    expect(requireRole).not.toHaveBeenCalled();
    expect(db.inserts).toHaveLength(0);
  });
});
