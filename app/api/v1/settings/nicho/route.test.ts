import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { createClient } from "@/lib/supabase/server";
import { GET, PATCH } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const org = "10000000-0000-4000-8000-000000000001";
const user = { id: "20000000-0000-4000-8000-000000000002" };

let settingsRow: { settings: Record<string, unknown> | null };

/** Fake pool: every statement the PATCH sends, in order, plus what each one answers. */
const statements: Array<{ sql: string; params: unknown[] }> = [];
let orgExists = true;
/** `null` = the org never chose the layer; otherwise the row's `enabled`. */
let layerRow: boolean | null = null;
const release = vi.fn();

const fakeClient = {
  release,
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    statements.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
    if (sql.includes("for update")) {
      return { rows: orgExists ? [{ nicho: (settingsRow.settings?.nicho as string | null) ?? null }] : [] };
    }
    if (sql.includes("insert into org_guardrail_layers")) {
      // one statement: what this call inserted, and the row as it stood before
      return {
        rows: [{ inserted: layerRow === null ? true : null, current: layerRow }],
        rowCount: 1,
      };
    }
    if (sql.includes("select enabled from org_guardrail_layers")) {
      return { rows: layerRow === null ? [] : [{ enabled: layerRow }] };
    }
    return { rows: [], rowCount: 1 };
  }),
};

const sqlSent = () => statements.map((s) => s.sql);

function makeQuery() {
  return {
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: settingsRow, error: null }),
      }),
    }),
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
  statements.length = 0;
  orgExists = true;
  layerRow = null;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: org, role: "admin" },
  } as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(createClient).mockResolvedValue({ from: () => makeQuery() } as unknown as Awaited<
    ReturnType<typeof createClient>
  >);
  vi.mocked(getRequestPool).mockReturnValue({ connect: async () => fakeClient } as unknown as ReturnType<
    typeof getRequestPool
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
  it("suporte readonly nega antes de tocar em requireRole ou no banco", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(new Response(null, { status: 403 }) as never);
    const response = await PATCH(req({ nicho: "saude" }));
    expect(response.status).toBe(403);
    expect(requireRole).not.toHaveBeenCalled();
    expect(getRequestPool).not.toHaveBeenCalled();
  });

  it.each([401, 403])("role viewer/negado recebe %s e não grava", async (status) => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status }),
    } as Awaited<ReturnType<typeof requireRole>>);
    const response = await PATCH(req({ nicho: "saude" }));
    expect(response.status).toBe(status);
    expect(statements).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("Zod recusa nicho fora do vocabulário fechado, sem gravar nem auditar", async () => {
    const response = await PATCH(req({ nicho: "clinica" }));
    expect(response.status).toBe(422);
    expect(statements).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("merges the key in the UPDATE itself — no read-modify-write of settings (issue #37)", async () => {
    settingsRow = { settings: { modo_sombra: true, nicho: null } };
    const response = await PATCH(req({ nicho: "ecommerce", organization_id: "outra-org" }));
    expect(response.status).toBe(200);
    const update = statements.find((s) => s.sql.startsWith("update organizations"));
    expect(update?.sql).toContain("settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('nicho', $2::text)");
    // organization from the session, never from the body
    expect(update?.params).toEqual([org, "ecommerce"]);
    expect(sqlSent()[0]).toBe("begin");
    expect(sqlSent().at(-1)).toBe("commit");
    expect(release).toHaveBeenCalled();
  });

  it("aceita null explícito (voltar para 'nenhum') sem tocar nas camadas", async () => {
    settingsRow = { settings: { nicho: "saude" } };
    const response = await PATCH(req({ nicho: null }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ nicho: null, clinical_claim_layer: null });
    expect(statements.find((s) => s.sql.startsWith("update organizations"))?.params).toEqual([org, null]);
    expect(sqlSent().some((s) => s.includes("org_guardrail_layers"))).toBe(false);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("'saude' switches upstream's afirmacao_clinica layer on when the org never chose, and audits both", async () => {
    const response = await PATCH(req({ nicho: "saude" }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ nicho: "saude", clinical_claim_layer: "enabled_now" });
    const insert = statements.find((s) => s.sql.includes("insert into org_guardrail_layers"));
    expect(insert?.sql).toContain("on conflict (organization_id, layer) do nothing");
    expect(insert?.params).toEqual([org, "afirmacao_clinica"]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "org.nicho_changed",
        actorUserId: user.id,
        organizationId: org,
        metadata: { antes: null, depois: "saude" },
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.guardrail_layer_changed",
        organizationId: org,
        metadata: { layer: "afirmacao_clinica", enabled: true, source: "niche" },
      }),
    );
  });

  it("'saude' with the layer already on reports already_on and audits only the niche", async () => {
    layerRow = true;
    const response = await PATCH(req({ nicho: "saude" }));
    expect((await response.json()).data).toEqual({ nicho: "saude", clinical_claim_layer: "already_on" });
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("'saude' never overrides a layer switched off by choice — and says so (off_by_choice)", async () => {
    layerRow = false;
    const response = await PATCH(req({ nicho: "saude" }));
    expect((await response.json()).data).toEqual({ nicho: "saude", clinical_claim_layer: "off_by_choice" });
    expect(sqlSent().some((s) => s.startsWith("update org_guardrail_layers"))).toBe(false);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("a database error answers 500 without leaking the pg message", async () => {
    fakeClient.query.mockImplementationOnce(async () => ({ rows: [] })); // begin
    fakeClient.query.mockImplementationOnce(async () => {
      throw new Error('relation "organizations" violates constraint "x"');
    });
    const response = await PATCH(req({ nicho: "saude" }));
    expect(response.status).toBe(500);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("organizations");
    expect(body).not.toContain("constraint");
    expect(audit).not.toHaveBeenCalled();
  });

  it("organização inexistente: 404, rollback, nada auditado", async () => {
    orgExists = false;
    const response = await PATCH(req({ nicho: "saude" }));
    expect(response.status).toBe(404);
    expect(sqlSent()).toContain("rollback");
    expect(sqlSent().some((s) => s.startsWith("update"))).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  it("sem SUPABASE_DB_URL: 503, nada auditado", async () => {
    vi.mocked(getRequestPool).mockImplementation(() => {
      throw new Error("SUPABASE_DB_URL ausente");
    });
    const response = await PATCH(req({ nicho: "saude" }));
    expect(response.status).toBe(503);
    expect(audit).not.toHaveBeenCalled();
  });
});
