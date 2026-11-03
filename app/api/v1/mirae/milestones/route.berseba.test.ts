// @vitest-environment node
/**
 * Berseba: the HTTP status of `POST /api/v1/mirae/milestones` tells Mirae's queue whether a retry
 * helps. Business outcomes are 200; a wrong map is 422; a concurrent edit (409) and a database
 * down (503) are retried.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, apply, support } = vi.hoisted(() => ({
  auth: vi.fn(),
  apply: vi.fn(),
  support: vi.fn(),
}));
vi.mock("@/lib/integrations/mirae/read-auth", () => ({ authorizeMiraeWrite: auth }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: support }));
vi.mock("@/lib/integrations/mirae/milestone", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  applyMiraeMilestone: apply,
}));

const { POST } = await import("./route");

const ORG = "0cc6e9e0-a9b0-42a4-951b-a0cb1e554a48";
const BODY = {
  milestone: "attended",
  phone: "(11) 98765-4321",
  pipeline_id: "0a7bc40c-45a3-47ed-ac0c-684fd8111ed2",
  stage_id: "ad205839-69f3-43e1-87de-21172b952522",
};

function call(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/v1/mirae/milestones", {
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
  apply.mockReset().mockResolvedValue({ outcome: "moved", leadId: "lead-1" });
});

describe("POST /api/v1/mirae/milestones", () => {
  it("answers the outcome with 200 and passes the organization of the token, never of the body", async () => {
    const res = await call(BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { outcome: "moved", lead_id: "lead-1" } });
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    expect(apply.mock.calls[0]![1]).toMatchObject({ organizationId: ORG, apiTokenId: "tok" });
  });

  it.each([
    [{ outcome: "no_contact" }, 200],
    [{ outcome: "refused", leadId: "l", code: "required_fields_missing", detail: "x" }, 200],
    [{ outcome: "invalid_stage", code: "stage_not_in_pipeline" }, 422],
    [{ outcome: "conflict", leadId: "l" }, 409],
    [{ outcome: "unavailable", detail: "down" }, 503],
  ])("%o → %i", async (result, status) => {
    apply.mockResolvedValueOnce(result);
    expect((await call(BODY)).status).toBe(status);
  });

  it("refuses a body that is not a milestone, and an organization_id in the body", async () => {
    expect((await call("not json")).status).toBe(400);
    expect((await call({ ...BODY, milestone: "absent" })).status).toBe(400);
    expect((await call({ ...BODY, organization_id: ORG })).status).toBe(400);
    expect(apply).not.toHaveBeenCalled();
  });

  it("the token check answers before anything else", async () => {
    auth.mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await call(BODY)).status).toBe(403);
    expect(apply).not.toHaveBeenCalled();
  });

  it("a read-only support session cannot write", async () => {
    support.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect((await call(BODY)).status).toBe(403);
    expect(apply).not.toHaveBeenCalled();
  });
});
