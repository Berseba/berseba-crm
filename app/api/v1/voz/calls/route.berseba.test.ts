// @vitest-environment node
/**
 * Berseba: "Ligar com a Bia" — `GET`/`POST /api/v1/voz/calls`. Session, `agent`; the contact rules
 * of the voice route; Voz's refusals become the team's sentences.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireRole, support, config, pedir, audit, db } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  support: vi.fn(),
  config: vi.fn(),
  pedir: vi.fn(),
  audit: vi.fn(),
  db: { lead: null as unknown, contato: null as unknown, erro: null as unknown },
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: support }));
vi.mock("@/lib/integrations/voz/config", () => ({ vozConfigFor: config }));
vi.mock("@/lib/integrations/voz/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pedirLigacaoNaVoz: pedir,
}));
vi.mock("@/lib/audit", () => ({ audit }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: table === "crm_leads" ? db.lead : db.contato,
          error: db.erro,
        }),
      };
      return q;
    },
  }),
}));

const { GET, POST } = await import("./route");

const ORG = "0cc6e9e0-a9b0-42a4-951b-a0cb1e554a48";
const LEAD = "11111111-1111-4111-8111-111111111111";
const CONFIG = { baseUrl: "https://voz.example", apiKey: "voz_k", orgIds: new Set([ORG]) };

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/v1/voz/calls", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function message(res: Response) {
  return ((await res.json()) as { error: { message: string } }).error.message;
}

beforeEach(() => {
  requireRole
    .mockReset()
    .mockResolvedValue({ ok: true, user: { id: "u1", idioma: "pt-BR" }, org: { orgId: ORG } });
  support.mockReset().mockResolvedValue(null);
  config.mockReset().mockReturnValue(CONFIG);
  pedir.mockReset().mockResolvedValue({ ok: true, callId: "c1" });
  audit.mockReset();
  db.lead = { id: LEAD, contact_id: "contact-1" };
  db.contato = { phone_number: "+5511987654321", is_blocked: false, is_personal: false, is_anonymized: false };
  db.erro = null;
});

describe("GET /api/v1/voz/calls", () => {
  it("says whether the button exists for this organization", async () => {
    expect(await (await GET()).json()).toEqual({ data: { ativo: true } });
    config.mockReturnValueOnce(null);
    expect(await (await GET()).json()).toEqual({ data: { ativo: false } });
    requireRole.mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await GET()).status).toBe(401);
  });
});

describe("POST /api/v1/voz/calls", () => {
  it("asks Voz for a call to the lead's contact, and audits it", async () => {
    const res = await post({ lead_id: LEAD });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { call_id: "c1" } });
    expect(pedir).toHaveBeenCalledWith(CONFIG, { phone: "+5511987654321", leadId: LEAD });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "voz.call_requested", resourceId: LEAD, metadata: { voz_call_id: "c1" } }),
    );
  });

  it("Voz's refusals come back with the team's sentence", async () => {
    pedir.mockResolvedValueOnce({ ok: false, codigo: "opted_out" });
    const res = await post({ lead_id: LEAD });
    expect(res.status).toBe(409);
    expect(await message(res)).toBe("Este número pediu para não receber ligações.");
    pedir.mockResolvedValueOnce({ ok: false, codigo: "daily_limit" });
    expect((await post({ lead_id: LEAD })).status).toBe(429);
    pedir.mockResolvedValueOnce({ ok: false, codigo: "unavailable" });
    expect((await post({ lead_id: LEAD })).status).toBe(503);
  });

  it("where Voz is off, nothing is asked", async () => {
    config.mockReturnValueOnce(null);
    expect((await post({ lead_id: LEAD })).status).toBe(404);
    expect(pedir).not.toHaveBeenCalled();
  });

  it("a blocked, personal or anonymized contact gets no call", async () => {
    for (const [flag, status] of [
      ["is_blocked", 403],
      ["is_personal", 403],
      ["is_anonymized", 422],
    ] as const) {
      db.contato = { phone_number: "+5511987654321", [flag]: true };
      expect((await post({ lead_id: LEAD })).status).toBe(status);
    }
    expect(pedir).not.toHaveBeenCalled();
  });

  it("no lead, no contact, no phone, a bad body, a dead database", async () => {
    expect((await post({ lead_id: "x" })).status).toBe(422);
    db.lead = null;
    expect((await post({ lead_id: LEAD })).status).toBe(404);
    db.lead = { id: LEAD, contact_id: null };
    expect((await post({ lead_id: LEAD })).status).toBe(422);
    db.lead = { id: LEAD, contact_id: "contact-1" };
    db.contato = { phone_number: " " };
    expect((await post({ lead_id: LEAD })).status).toBe(422);
    db.erro = { message: "down" };
    expect((await post({ lead_id: LEAD })).status).toBe(500);
    expect(pedir).not.toHaveBeenCalled();
  });

  it("the session and the support guard answer first", async () => {
    support.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect((await post({ lead_id: LEAD })).status).toBe(403);
    requireRole.mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await post({ lead_id: LEAD })).status).toBe(401);
  });
});
