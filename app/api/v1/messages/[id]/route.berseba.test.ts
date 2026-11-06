/**
 * Berseba: a manager or admin may edit or delete-for-everyone what the AI agent
 * sent (`sent_via = 'ai'`). The attendant's own-message path stays as upstream
 * wrote it, and every other origin stays refused.
 *
 * Same harness as `route.test.ts`, with the caller's role configurable.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  role: "manager" as string,
  message: null as Record<string, unknown> | null,
  calls: [] as Array<{ table: string; update?: Record<string, unknown> }>,
  edit: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
  audit: vi.fn(async () => undefined),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "user-1", idioma: "pt-BR" },
    org: { orgId: "org-1", role: state.role },
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: state.audit }));
vi.mock("@/lib/channels/endereco-da-ultima-recebida", () => ({
  enderecoDaUltimaRecebida: async () => null,
}));
vi.mock("@/lib/channels", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  transportaMensagem: () => true,
  resolveSessionRef: () => "session-ref-1",
  getAdapter: () => ({
    isConfigured: () => true,
    resolveRecipient: () => "chat-1",
    editMessage: state.edit,
    revokeMessage: state.remove,
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const q = {
        select: () => q, eq: () => q, is: () => q, order: () => q, limit: () => q,
        update: (update: Record<string, unknown>) => { state.calls.push({ table, update }); return q; },
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(ok, fail),
        maybeSingle: async () => ({ data: table === "messages"
          ? state.calls.some((c) => c.table === "messages" && c.update)
            ? { id: state.message?.id, body: "after", edited_at: "now", revoked_at: null }
            : state.message
          : table === "conversations"
            ? { id: "conversation-1", contact_id: "contact-1", is_group: false, channel_session_id: "session-1" }
            : table === "channel_sessions"
              ? { provider: "test-channel", archived_at: null }
              : { phone_number: "5514999999999", wa_identity: null, wa_lid: null }, error: null }),
      };
      return q;
    },
  }),
}));

import { DELETE, PATCH } from "./route";

const id = "22222222-2222-4222-8222-222222222222";
const ctx = { params: Promise.resolve({ id }) };
const url = `http://localhost/api/v1/messages/${id}`;
const patch = () => PATCH(new NextRequest(url, { method: "PATCH", body: JSON.stringify({ text: "after" }) }), ctx);
const del = () => DELETE(new NextRequest(url, { method: "DELETE" }), ctx);

beforeEach(() => {
  state.role = "manager";
  state.calls.length = 0;
  state.edit.mockClear();
  state.remove.mockClear();
  state.audit.mockClear();
  state.message = {
    id, organization_id: "org-1", conversation_id: "conversation-1", channel_session_id: "session-1",
    external_id: "AI-EXT", direction: "outbound", type: "text", status: "delivered",
    body: "wrong AI reply", sent_via: "ai", sent_by_user_id: null,
    sent_at: new Date().toISOString(), revoked_at: null,
  };
});

describe("manager alters a message the AI agent sent", () => {
  it("a manager edits an AI message through the channel and the audit names its origin", async () => {
    const res = await patch();
    expect(res.status).toBe(200);
    expect(state.edit).toHaveBeenCalledWith(expect.objectContaining({ externalId: "AI-EXT", text: "after" }));
    expect(state.calls).toContainEqual({ table: "messages", update: expect.objectContaining({ body: "after" }) });
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "message.edited",
      actorUserId: "user-1",
      metadata: expect.objectContaining({ sent_via: "ai", conteudo_preservado: true }),
    }));
    // The body never goes into the audit trail.
    expect(JSON.stringify(state.audit.mock.calls)).not.toContain("wrong AI reply");
  });

  it("an admin deletes an AI message for everyone", async () => {
    state.role = "admin";
    const res = await del();
    expect(res.status).toBe(200);
    expect(state.remove).toHaveBeenCalledOnce();
    expect(state.calls).toContainEqual({ table: "messages", update: expect.objectContaining({ revoked_at: expect.any(String) }) });
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "message.revoked",
      metadata: expect.objectContaining({ sent_via: "ai" }),
    }));
  });

  it("an agent is refused with 403 and the channel is never called", async () => {
    state.role = "agent";
    expect((await patch()).status).toBe(403);
    expect((await del()).status).toBe(403);
    expect(state.edit).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
    expect(state.audit).not.toHaveBeenCalled();
  });

  it.each(["automation", "system", "external_device"])("a manager still cannot alter a %s message", async (sentVia) => {
    state.message = { ...state.message, sent_via: sentVia };
    expect((await patch()).status).toBe(403);
    expect((await del()).status).toBe(403);
    expect(state.edit).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
  });

  it("a manager still cannot alter a colleague's message", async () => {
    state.message = { ...state.message, sent_via: "user", sent_by_user_id: "colleague-1" };
    expect((await del()).status).toBe(403);
    expect(state.remove).not.toHaveBeenCalled();
  });

  it("the other conditions still hold for AI messages: edit window, text only, status", async () => {
    state.message = { ...state.message, sent_at: new Date(Date.now() - 16 * 60 * 1000).toISOString() };
    expect((await patch()).status).toBe(409);
    state.message = { ...state.message, sent_at: new Date().toISOString(), type: "image" };
    expect((await patch()).status).toBe(403);
    state.message = { ...state.message, type: "text", status: "failed" };
    expect((await del()).status).toBe(403);
    state.message = { ...state.message, status: "sent", revoked_at: "2026-11-06T12:00:00.000Z" };
    expect((await del()).status).toBe(403);
    expect(state.edit).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
  });
});

describe("attendant's own message (upstream path) is unchanged", () => {
  it("an agent still edits and deletes their own CRM message", async () => {
    state.role = "agent";
    state.message = { ...state.message, sent_via: "crm", sent_by_user_id: "user-1" };
    expect((await patch()).status).toBe(200);
    state.calls.length = 0;
    expect((await del()).status).toBe(200);
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ sent_via: "crm" }),
    }));
  });
});
