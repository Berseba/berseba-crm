// @vitest-environment node
/**
 * Berseba: the HTTP answers of `POST /api/v1/mirae/reminder-messages` tell Mirae's queue whether
 * a retry helps. Business outcomes are 200 with `data.outcome`; a malformed body (400), reminder
 * messages turned off and an invalid charge (422) are final; a database that is not configured is 503.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ReminderMessage from "@/lib/integrations/mirae/reminder-message";

const { auth, queue, support, pool, auditFn } = vi.hoisted(() => ({
  auth: vi.fn(),
  queue: vi.fn(),
  support: vi.fn(),
  pool: vi.fn(),
  auditFn: vi.fn(),
}));
vi.mock("@/lib/integrations/mirae/read-auth", () => ({ authorizeMiraeWrite: auth }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: support }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: pool }));
vi.mock("@/lib/agent-engine/agent/human-handoff", () => ({ isLeadInHandoff: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: auditFn }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.example/" } }));
vi.mock("@/lib/integrations/mirae/reminder-message", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  queueMiraeReminderMessage: queue,
}));

const { POST } = await import("./route");

const ORG = "0cc6e9e0-a9b0-42a4-951b-a0cb1e554a48";
const BODY = {
  reminder_id: "rem-1",
  delivery_key: "rem-1:2026-11-18T12:00:00.000Z",
  phone: "(14) 99659-8955",
  studentName: "Ana",
  title: "Confirmar avaliação",
  note: null,
  as_of: "2026-11-17T11:00:00.000Z",
};

function call(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/v1/mirae/reminder-messages", {
      method: "POST",
      headers: { authorization: "Bearer dsk_x", "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  auth
    .mockReset()
    .mockResolvedValue({ ok: true, organizationId: ORG, apiTokenId: "tok", supabase: {} });
  support.mockReset().mockResolvedValue(null);
  pool.mockReset().mockReturnValue({});
  auditFn.mockReset().mockResolvedValue(undefined);
  queue
    .mockReset()
    .mockResolvedValue({ outcome: "drafted", delivery: "draft", cronJobId: "job-1", conversationId: "conv-1" });
});

describe("POST /api/v1/mirae/reminder-messages", () => {
  it("drafted: 200 with the conversation link, organization of the token, audited once", async () => {
    const res = await call({ ...BODY, organization_id: "11111111-1111-4111-8111-111111111111" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { outcome: "drafted", conversation_url: "https://crm.example/app/inbox/conv-1" },
    });
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    expect(queue.mock.calls[0]![1]).toMatchObject({ organizationId: ORG });
    expect(auditFn).toHaveBeenCalledTimes(1);
    expect(auditFn.mock.calls[0]![0]).toMatchObject({
      action: "mirae.reminder_message_queued",
      organizationId: ORG,
      actorApiTokenId: "tok",
      resourceType: "conversation",
      resourceId: "conv-1",
    });
  });

  it("scheduled: 200, audited", async () => {
    queue.mockResolvedValueOnce({ outcome: "scheduled", delivery: "auto", cronJobId: "j", conversationId: "c" });
    const res = await call({ ...BODY, kind: "evaluation_confirmation" });
    expect(res.status).toBe(200);
    expect((await res.json()).data.outcome).toBe("scheduled");
    expect(auditFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ outcome: "already_drafted", conversationId: "c" }, { outcome: "already_drafted", conversation_url: "https://crm.example/app/inbox/c" }],
    [{ outcome: "scheduled", replayed: true, conversationId: "c" }, { outcome: "scheduled", conversation_url: "https://crm.example/app/inbox/c", replayed: true }],
    [{ outcome: "already_handled", conversationId: "c" }, { outcome: "already_handled", conversation_url: "https://crm.example/app/inbox/c" }],
    [{ outcome: "contact_blocked", conversationId: "c" }, { outcome: "contact_blocked", conversation_url: "https://crm.example/app/inbox/c" }],
    [{ outcome: "contact_not_found" }, { outcome: "contact_not_found" }],
  ])("%o → 200 %o, not audited", async (result, data) => {
    queue.mockResolvedValueOnce(result);
    const res = await call(BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data });
    expect(auditFn).not.toHaveBeenCalled();
  });

  it("turned off for the organization: 422, final", async () => {
    queue.mockResolvedValueOnce({ outcome: "disabled" });
    const res = await call(BODY);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("reminder_messages_disabled");
  });

  describe("charge notice (kind: charge)", () => {
    const CHARGE = {
      ...BODY,
      reminder_id: "charge_1",
      delivery_key: "charge_1:2026-11-25",
      title: "Cobrança da parcela 3/12",
      kind: "charge",
      charge_link: "https://www.asaas.com/i/k7f2x9q1ab3c",
      // The route reads the real clock: a due date a week from today.
      charge_due_date: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString().slice(0, 10),
      charge_amount_cents: 29900,
    };
    // The real rule: an invalid charge is refused before the database is touched.
    const realRule = async () => {
      const actual = await vi.importActual<typeof ReminderMessage>(
        "@/lib/integrations/mirae/reminder-message",
      );
      queue.mockImplementationOnce(actual.queueMiraeReminderMessage);
    };

    it("the charge fields reach the rule as Mirae sent them", async () => {
      queue.mockResolvedValueOnce({ outcome: "scheduled", delivery: "auto", cronJobId: "j", conversationId: "c" });
      const res = await call(CHARGE);
      expect(res.status).toBe(200);
      expect((await res.json()).data.outcome).toBe("scheduled");
      expect(queue.mock.calls[0]![2]).toMatchObject({
        kind: "charge",
        charge_link: "https://www.asaas.com/i/k7f2x9q1ab3c",
        charge_due_date: CHARGE.charge_due_date,
        charge_amount_cents: 29900,
      });
    });

    it.each([
      [{ charge_link: "https://evil.example/i/abc" }, ["charge_link"]],
      [{ charge_link: "http://www.asaas.com/i/abc" }, ["charge_link"]],
      [{ charge_due_date: "25/11" }, ["charge_due_date"]],
      [{ charge_amount_cents: -1 }, ["charge_amount_cents"]],
      [{ charge_link: undefined, charge_amount_cents: undefined }, ["charge_link", "charge_amount_cents"]],
    ])("%o → 422 invalid_charge, final, not audited", async (patch, fields) => {
      await realRule();
      const res = await call({ ...CHARGE, ...patch });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatchObject({ code: "invalid_charge", details: { fields } });
      expect(auditFn).not.toHaveBeenCalled();
    });

    it("an amount that is not a number is an invalid charge too (422, naming the field)", async () => {
      await realRule();
      const res = await call({ ...CHARGE, charge_amount_cents: "299,00" });
      expect(res.status).toBe(422);
      expect((await res.json()).error.details).toEqual({ fields: ["charge_amount_cents"] });
    });
  });

  it("refuses a body that is not a reminder", async () => {
    expect((await call("not json")).status).toBe(400);
    expect((await call({ ...BODY, title: "" })).status).toBe(400);
    expect((await call({ ...BODY, reminder_id: undefined })).status).toBe(400);
    expect((await call({ ...BODY, appointment_start_at: "amanhã" })).status).toBe(400);
    expect(queue).not.toHaveBeenCalled();
  });

  it("the token check answers before anything else", async () => {
    auth.mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await call(BODY)).status).toBe(401);
    auth.mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await call(BODY)).status).toBe(403);
    auth.mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 429 }) });
    expect((await call(BODY)).status).toBe(429);
    expect(queue).not.toHaveBeenCalled();
  });

  it("a read-only support session cannot write", async () => {
    support.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect((await call(BODY)).status).toBe(403);
    expect(queue).not.toHaveBeenCalled();
  });

  it("no database configured: 503, retried by Mirae", async () => {
    pool.mockImplementationOnce(() => {
      throw new Error("SUPABASE_DB_URL ausente");
    });
    const res = await call(BODY);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("an unexpected error: 500, retried by Mirae", async () => {
    queue.mockRejectedValueOnce(new Error("boom"));
    expect((await call(BODY)).status).toBe(500);
  });
});
