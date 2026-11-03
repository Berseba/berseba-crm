/**
 * Berseba: the Mirae write needs `mcp:write` and at least `agent`, and counts in its own bucket
 * under the write ceiling; a read needs only `mcp:read`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { validate, limit } = vi.hoisted(() => ({ validate: vi.fn(), limit: vi.fn() }));
vi.mock("@/lib/mcp/auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  validateBearerToken: validate,
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: limit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const { authorizeMiraeRead, authorizeMiraeWrite } = await import("./read-auth");
const { TETO_DE_ESCRITA, TETO_POR_TOKEN } = await import("@/lib/mcp/rate-limit");

function token(scopes: string[], role = "agent") {
  return { organizationId: "org-1", apiTokenId: "tok-1", role, scopes, actor: {} };
}

beforeEach(() => {
  validate.mockReset();
  limit.mockReset().mockResolvedValue({ allowed: true });
});

describe("authorizeMiraeWrite", () => {
  it("accepts an agent token with mcp:write, in the write bucket under the write ceiling", async () => {
    validate.mockResolvedValue(token(["mcp:write"]));
    const r = await authorizeMiraeWrite("Bearer dsk_x", "req");
    expect(r).toMatchObject({ ok: true, organizationId: "org-1", apiTokenId: "tok-1" });
    expect(limit).toHaveBeenCalledWith("mirae-write:tok:tok-1", TETO_DE_ESCRITA, 60);
  });

  it("refuses a read-only token and a viewer token with 403", async () => {
    for (const t of [token(["mcp:read"]), token(["mcp:write"], "viewer")]) {
      validate.mockResolvedValueOnce(t);
      const r = await authorizeMiraeWrite("Bearer dsk_x", "req");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.response.status).toBe(403);
    }
    expect(limit).not.toHaveBeenCalled();
  });
});

describe("authorizeMiraeRead", () => {
  it("accepts a viewer token with mcp:read, in the read bucket under the read ceiling", async () => {
    validate.mockResolvedValue(token(["mcp:read"], "viewer"));
    expect((await authorizeMiraeRead("Bearer dsk_x", "req")).ok).toBe(true);
    expect(limit).toHaveBeenCalledWith("mirae-read:tok:tok-1", TETO_POR_TOKEN, 60);
  });
});
