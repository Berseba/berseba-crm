/**
 * Berseba: the agent's history says who wrote each outbound message.
 *
 * Studio Bruno Alves (audit of 2026-11-04): the team sends renewal offers from
 * the number the agent answers, and the agent carried on the team's campaign
 * ("qual das opções de plano fica melhor pra você?") because every outbound
 * reached the model as its own. These cases cover the three `sent_via` values
 * of that incident (`ai`, `user`, `external_device`) through the three layers
 * the model reads: the context, the projection and the opening text.
 */
import { describe, expect, it, vi } from "vitest";

import { buildOpeningMessage } from "@/lib/agent-engine/agent/abertura/ritual";
import { projetarContexto } from "@/lib/agent-engine/agent/projecao";
import { getLeadContext, type LeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";
import {
  historyAuthorshipNote,
  outboundAuthor,
} from "@/lib/agent-engine/edge/crm/outbound-author.berseba";

const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT_ID = "11111111-1111-4111-8111-111111111111";

function row(direction: "inbound" | "outbound", body: string, sentVia: string, minute: number) {
  return {
    direction,
    type: "text",
    body,
    media_url: null,
    media_storage_path: null,
    media_mime: null,
    media_derived_text: null,
    sent_at: new Date(`2026-11-03T12:${String(minute).padStart(2, "0")}:00Z`),
    metadata: null,
    sent_via: sentVia,
  };
}

// The incident, in the order the query returns it (newest first).
const HISTORY = [
  row("outbound", "Oi! Quer que eu te ajude com mais alguma coisa?", "ai", 4),
  row("outbound", "Segue o link do pagamento do plano trimestral.", "user", 3),
  row("inbound", "Qual é o valor?", "external_device", 2),
  row(
    "outbound",
    "Sua renovação vence semana que vem. Temos o mensal e o trimestral.",
    "external_device",
    1,
  ),
];

function fakeDb(history: Array<Record<string, unknown>>) {
  const queries: string[] = [];
  const db = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("from contacts")) {
        return {
          rows: [
            {
              name: "Aluna",
              display_name: null,
              email: null,
              phone_number: "5511",
              tags: [],
              is_blocked: false,
              source: "whatsapp",
              consent: null,
              is_anonymized: false,
            },
          ],
        };
      }
      // A copy: getLeadContext reverses the rows in place.
      if (sql.includes("from messages")) return { rows: [...history] };
      return { rows: [] };
    }),
  };
  return { db, queries };
}

async function contextOf(
  history: Array<Record<string, unknown>>,
): Promise<{ context: LeadContext; queries: string[] }> {
  const { db, queries } = fakeDb(history);
  const r = await getLeadContext(
    db as never,
    {} as never,
    {
      tenantId: TENANT_ID,
      leadId: CONTACT_ID,
      conversationId: "conv-1",
      fuso: "America/Sao_Paulo",
    },
    { historyLimit: 20, maxTokens: 4000 },
  );
  if (!r.ok) throw new Error(`getLeadContext failed: ${r.error.code}`);
  return { context: r.context, queries };
}

describe("outboundAuthor", () => {
  it.each([
    ["ai", "agent"],
    ["user", "team"],
    ["crm", "team"],
    ["external_device", "team"],
    ["automation", "automation"],
    ["system", "automation"],
  ] as const)("sent_via=%s → %s", (sentVia, author) => {
    expect(outboundAuthor(sentVia)).toBe(author);
  });

  it("a missing or unknown sent_via is never the agent's own speech", () => {
    expect(outboundAuthor(null)).toBe("team");
    expect(outboundAuthor(undefined)).toBe("team");
    expect(outboundAuthor("something_new")).toBe("team");
  });
});

describe("getLeadContext: outbound messages carry their author", () => {
  it("reads sent_via from messages", async () => {
    const { queries } = await contextOf(HISTORY);
    const historyQuery = queries.find((q) => q.includes("from messages")) ?? "";
    expect(historyQuery).toMatch(/\bsent_via\b/);
  });

  it("ai → agent, user → team, external_device → team; inbound has no author", async () => {
    const { context } = await contextOf(HISTORY);
    expect(context.messages.map((m) => [m.direction, m.author])).toEqual([
      ["outbound", "team"], // typed on the phone
      ["inbound", undefined],
      ["outbound", "team"], // sent from the CRM
      ["outbound", "agent"],
    ]);
    expect(context.messages[1]).not.toHaveProperty("author");
  });

  it("the raw JSON the model reads names the author", async () => {
    const { context } = await contextOf(HISTORY);
    const json = JSON.stringify(context);
    expect(json).toContain('"direction":"outbound","author":"team","body":"Sua renovação vence');
    expect(json).toContain('"direction":"outbound","author":"agent","body":"Oi! Quer que eu');
  });
});

describe("projetarContexto: `de` names the author", () => {
  it("cliente / equipe / você, never a shared 'nós'", async () => {
    const { context } = await contextOf(HISTORY);
    const p = projetarContexto(context);
    expect(p.mensagens.map((m) => m.de)).toEqual(["equipe", "cliente", "equipe", "você"]);
    expect(JSON.stringify(p)).not.toContain('"nós"');
  });

  it("automation is neither the agent nor a person", async () => {
    const { context } = await contextOf([row("outbound", "Feliz aniversário!", "automation", 1)]);
    expect(projetarContexto(context).mensagens[0]!.de).toBe("automação");
  });

  it("an outbound built without an author reads as the team", () => {
    const p = projetarContexto({
      lead_id: "",
      contact: { name: "Aluna", phone: null, email: null, tags: [], is_blocked: false },
      conversation_id: null,
      last_human_decision: null,
      messages: [{ direction: "outbound", body: "oi", sent_at: "2026-11-03T09:00:00-03:00" }],
    });
    expect(p.mensagens[0]!.de).toBe("equipe");
  });
});

describe("the opening explains the authors", () => {
  it("projected: the note sits under the history heading and the team's offer is 'equipe'", async () => {
    const { context } = await contextOf(HISTORY);
    const text = buildOpeningMessage(null, null, context, "—", true);
    const heading = text.indexOf("## Contexto do lead (contato + últimas mensagens)");
    expect(heading).toBeGreaterThan(-1);
    expect(text.indexOf(historyAuthorshipNote(true))).toBeGreaterThan(heading);
    expect(text).toContain('"de":"equipe","texto":"Sua renovação vence');
  });

  it("raw: the note explains `author` instead of `de`", async () => {
    const { context } = await contextOf(HISTORY);
    const text = buildOpeningMessage(null, null, context, "—", false);
    expect(text).toContain(historyAuthorshipNote(false));
    expect(text).not.toContain(historyAuthorshipNote(true));
    expect(historyAuthorshipNote(false)).toContain("`author`");
    expect(historyAuthorshipNote(true)).toContain("`de`");
  });
});
