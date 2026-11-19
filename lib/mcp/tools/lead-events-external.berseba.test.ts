/**
 * Berseba (Berseba/berseba#270): the platform calls `crm_list_lead_events` and
 * `crm_list_leads` with a `dsk_` token through `/api/mcp`, outside any agent turn.
 *
 * The external server (`createMcpServer`) filters tools only by installation module,
 * organization capability and the Berseba agenda gates (avec, Mirae, Atos). Bundles
 * (`pacotes`) only shape the agent's tool selection screen, so the `escalar` bundle of
 * `crm_list_lead_events` must not hide it from an API token with `mcp:read` and the
 * default role (`agent`, when the token has no `role:` scope).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/mcp/rate-limit", () => ({ verificarTetoMcp: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "gte", "order", "range", "limit", "not", "contains"]) {
        c[m] = () => c;
      }
      c.then = (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
      return c;
    },
  }),
}));

const { createMcpServer } = await import("@/lib/mcp/server");

const AUTH = {
  organizationId: "00000000-0000-4000-8000-00000000000b",
  role: "agent" as const,
  actor: { type: "api_token" as const, id: "tok", role: "agent" as const },
  apiTokenId: "tok",
  scopes: ["mcp:read"],
};

async function connect() {
  // No modules and no organization capabilities on: the narrowest installation.
  const server = createMcpServer(AUTH, "req-1", [], []);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "prospector-test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

describe("crm_list_lead_events through /api/mcp with an API token", () => {
  it("is listed, with crm_list_leads, for a token with mcp:read and the default role", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();
    const names = tools.map((t) => t.name);
    expect(names).toContain("crm_list_lead_events");
    expect(names).toContain("crm_list_leads");
  });

  it("answers a call", async () => {
    const client = await connect();
    const r = (await client.callTool({
      name: "crm_list_lead_events",
      arguments: {
        lead_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
        since: "2026-11-01T00:00:00-03:00",
      },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    await client.close();
    expect(r.isError, r.content[0]?.text).not.toBe(true);
    expect(JSON.parse(r.content[0]?.text ?? "{}")).toEqual({ events: [] });
  });
});
