// @vitest-environment node
/**
 * Berseba: the HTTP status of `POST /api/v1/voz/call-ended` tells Voz whether a retry helps.
 * Business outcomes are 200; a bad body is 400 (never retried); a concurrent edit (409) and a
 * database down (503) are retried.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, apply, support } = vi.hoisted(() => ({
  auth: vi.fn(),
  apply: vi.fn(),
  support: vi.fn(),
}));
vi.mock("@/lib/integrations/voz/auth", () => ({ authorizeVozWrite: auth }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: support }));
vi.mock("@/lib/integrations/voz/report", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  applyVozReport: apply,
}));

const { POST } = await import("./route");

const ORG = "0cc6e9e0-a9b0-42a4-951b-a0cb1e554a48";
const BODY = {
  event: "call.ended",
  call_id: "44444444-4444-4444-8444-444444444444",
  to: "5511987654321",
  lead_ref: { id: "11111111-1111-4111-8111-111111111111" },
  status: "ended",
  outcome: "interested",
  summary: "Quer saber mais.",
  objections: ["preço"],
  action_plan: "- Mandar material",
  action_steps: [{ step: "Mandar material", owner: "team" }],
  next_step: null,
  next_step_at: null,
  duration_s: 90,
  cost_usd: 0.01,
  ended_at: "2026-11-12T15:00:00Z",
};

function call(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/v1/voz/call-ended", {
      method: "POST",
      headers: { authorization: "Bearer dsk_x", "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  auth.mockReset().mockResolvedValue({ ok: true, organizationId: ORG, apiTokenId: "tok", supabase: {} });
  support.mockReset().mockResolvedValue(null);
  apply.mockReset().mockResolvedValue({ outcome: "applied", leadId: "lead-1", resultado: "follow_up" });
});

describe("POST /api/v1/voz/call-ended", () => {
  it("answers the outcome with 200, with the organization of the token", async () => {
    const res = await call(BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { outcome: "applied", lead_id: "lead-1", resultado: "follow_up" },
    });
    expect(apply.mock.calls[0]![1]).toMatchObject({ organizationId: ORG, apiTokenId: "tok" });
  });

  it.each([
    [{ outcome: "already_applied", leadId: "l" }, 200],
    [{ outcome: "no_contact" }, 200],
    [{ outcome: "no_lead" }, 200],
    [{ outcome: "refused", leadId: "l", code: "stage_missing" }, 200],
    [{ outcome: "conflict", leadId: "l" }, 409],
    [{ outcome: "unavailable", detail: "down" }, 503],
  ])("%o → %i", async (result, status) => {
    apply.mockResolvedValueOnce(result);
    expect((await call(BODY)).status).toBe(status);
  });

  it("refuses a body that is not a report", async () => {
    expect((await call("not json")).status).toBe(400);
    expect((await call({ ...BODY, outcome: "maybe" })).status).toBe(400);
    expect((await call({ ...BODY, call_id: "x" })).status).toBe(400);
    expect(apply).not.toHaveBeenCalled();
  });

  it("the token check and the support guard answer before anything else", async () => {
    auth.mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await call(BODY)).status).toBe(401);
    support.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect((await call(BODY)).status).toBe(403);
    expect(apply).not.toHaveBeenCalled();
  });

  it("an unexpected error is a 500", async () => {
    apply.mockRejectedValueOnce(new Error("boom"));
    expect((await call(BODY)).status).toBe(500);
  });
});
