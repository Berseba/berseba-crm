import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { GET, PATCH } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const org = "10000000-0000-4000-8000-000000000001";
const user = { id: "20000000-0000-4000-8000-000000000002" };

let settingsRow: { settings: Record<string, unknown> | null };
const update = vi.fn();

function makeQuery() {
  return {
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: settingsRow, error: null }),
      }),
    }),
    update: (payload: Record<string, unknown>) => {
      update(payload);
      return { eq: async () => ({ error: null }) };
    },
  };
}

const req = (body: unknown) =>
  new NextRequest("http://localhost/api/v1/settings/nicho", {
    method: "PATCH",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  settingsRow = { settings: {} };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: org, role: "admin" },
  } as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(createClient).mockResolvedValue({ from: () => makeQuery() } as unknown as Awaited<
    ReturnType<typeof createClient>
  >);
  vi.mocked(createAdminClient).mockReturnValue({ from: () => makeQuery() } as unknown as ReturnType<
    typeof createAdminClient
  >);
});

describe("GET /api/v1/settings/nicho", () => {
  it("nega sem role suficiente e não consulta o banco", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as Awaited<ReturnType<typeof requireRole>>);
    const response = await GET(req(null) as unknown as NextRequest);
    expect(response.status).toBe(403);
  });

  it("devolve null quando a organização não escolheu nicho", async () => {
    const response = await GET(req(null) as unknown as NextRequest);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ nicho: null });
  });

  it("devolve o nicho gravado", async () => {
    settingsRow = { settings: { nicho: "saude" } };
    const response = await GET(req(null) as unknown as NextRequest);
    expect((await response.json()).data).toEqual({ nicho: "saude" });
  });

  it("valor fora do vocabulário no banco (clone antigo/dado sujo) cai para null, nunca 500", async () => {
    settingsRow = { settings: { nicho: "valor-desconhecido" } };
    const response = await GET(req(null) as unknown as NextRequest);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ nicho: null });
  });
});

describe("PATCH /api/v1/settings/nicho", () => {
  it("suporte readonly nega antes de tocar em requireRole ou no service role", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(new Response(null, { status: 403 }) as never);
    const response = await PATCH(req({ nicho: "saude" }));
    expect(response.status).toBe(403);
    expect(requireRole).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it.each([401, 403])("role viewer/negado recebe %s e não grava", async (status) => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status }),
    } as Awaited<ReturnType<typeof requireRole>>);
    const response = await PATCH(req({ nicho: "saude" }));
    expect(response.status).toBe(status);
    expect(update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("Zod recusa nicho fora do vocabulário fechado, sem gravar nem auditar", async () => {
    const response = await PATCH(req({ nicho: "clinica" }));
    expect(response.status).toBe(422);
    expect(update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("aceita null explícito (voltar para 'nenhum')", async () => {
    settingsRow = { settings: { nicho: "saude" } };
    const response = await PATCH(req({ nicho: null }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ nicho: null });
    expect(update).toHaveBeenCalledWith({ settings: { nicho: null } });
  });

  it("grava 'saude', preserva as demais chaves de settings, audita antes/depois e organização vem da sessão (nunca do body)", async () => {
    settingsRow = { settings: { modo_sombra: true, nicho: null } };
    const response = await PATCH(req({ nicho: "saude", organization_id: "outra-org" }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ nicho: "saude" });
    expect(update).toHaveBeenCalledWith({ settings: { modo_sombra: true, nicho: "saude" } });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "org.nicho_changed",
        actorUserId: user.id,
        organizationId: org,
        metadata: { antes: null, depois: "saude" },
      }),
    );
  });
});
