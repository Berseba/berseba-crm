// @vitest-environment node
/**
 * Berseba (#57): the `message.sent` automation trigger, "Mensagem enviada pela equipe".
 *
 * Runs the REAL engine (`runAutomationForEvent`) and the REAL `create_or_move_lead`
 * / `add_tag` actions against the in-memory database double of the funnel routes
 * (`tests/helpers/stages-db-double.ts`), which applies `eq`/`neq`/`limit` for real.
 * Each "does not run" case has a control case that does run with the same world,
 * so "the lead did not move" can never be an empty assertion.
 *
 *     pnpm vitest run lib/automation/message-sent.test.ts
 */
import { describe, expect, it, vi } from "vitest";

const originRpc = vi.hoisted(() => vi.fn(async (_fn: string, _args: unknown) => ({ data: null, error: null })));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: originRpc }) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// The double imports these modules for its own helpers; without the mocks the
// real `lib/auth/server` validates env at import time (same as create-or-move-lead.test.ts).
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { TRIGGER_LABELS } from "@/app/app/webhooks/_components/labels";
import "@/lib/automation/actions/add-tag";
import "@/lib/automation/actions/create-or-move-lead";
import { automationRulesHandler } from "@/lib/automation/engine.handler";
import { AUTOMATION_CONSUMER_KEY, buildContext, runAutomationForEvent } from "@/lib/automation/engine";
import { ruleAcceptsOrigin } from "@/lib/automation/message-sent";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import { ENTIDADE_ESPERADA_POR_GATILHO, TRIGGER_EVENTS } from "@/lib/schemas/webhooks";
import { ORG_ID, PIPE, etapa, funilRow, makeDb, negocio } from "@/tests/helpers/stages-db-double";

const CONTACT = "contato-ruth-1";
const MESSAGE = "msg-1";
const CONVERSATION = "conv-1";
const RULE = "rule-deixamos-agendado";
const OTHER_PIPE = "55555555-5555-4555-8555-555555555555";

const NEW_CONTACT = etapa({ id: "novo-contato", name: "Novo contato", position: 1000 });
const BOOKED = etapa({ id: "horario-marcado", name: "Horário marcado", position: 6000 });
const OTHER_STAGE = etapa({ id: "outra-etapa", name: "Outra", position: 1000, pipeline_id: OTHER_PIPE });

type Row = Record<string, unknown>;

interface World {
  sentVia?: string;
  status?: string;
  body?: string;
  conditions?: Row[];
  actions?: Row[];
  /** Leads of the contact, most recent FIRST (the double keeps insertion order). */
  leads?: ReturnType<typeof negocio>[];
  withMessage?: boolean;
}

function world(w: World = {}) {
  const db = makeDb({
    contacts: [{ id: CONTACT, organization_id: ORG_ID, name: "Cliente", tags: [] }],
    pipelines: [funilRow({ id: PIPE, name: "Agendamentos" }), funilRow({ id: OTHER_PIPE, name: "Outro" })],
    stages: [NEW_CONTACT, BOOKED, OTHER_STAGE],
    leads: w.leads ?? [openLead("lead-1", NEW_CONTACT.id)],
    automationRules: [
      {
        id: RULE,
        organization_id: ORG_ID,
        name: "Fecha o agendamento",
        trigger_event: "message.sent",
        is_active: true,
        conditions: w.conditions ?? [{ field: "event.body_preview", op: "contains", value: "deixamos agendado" }],
        actions: w.actions ?? [
          { type: "create_or_move_lead", config: { pipeline_id: PIPE, stage_id: BOOKED.id } },
        ],
        run_count: 0,
      },
    ],
  });
  const tables = db.tabelas as unknown as Record<string, Row[]>;
  tables.messages =
    w.withMessage === false
      ? []
      : [
          {
            id: MESSAGE,
            organization_id: ORG_ID,
            conversation_id: CONVERSATION,
            contact_id: CONTACT,
            direction: "outbound",
            status: w.status ?? "sent",
            sent_via: w.sentVia ?? "external_device",
            body: w.body ?? "Deixamos agendado conforme conversado, até sábado!",
          },
        ];
  return { db, tables, admin: db.client as unknown as Parameters<typeof runAutomationForEvent>[0] };
}

function openLead(id: string, stageId: string, pipelineId = PIPE) {
  return negocio(id, stageId, { contact_id: CONTACT, pipeline_id: pipelineId, status: "open", tags: [] } as never);
}

/** The phone reply: born from `fn_emit_message_event` (body_preview, contact_id; no sent_via). */
function phoneEvent(metadata: Row = {}): EventRow {
  return {
    id: "evt-phone",
    organization_id: ORG_ID,
    event_type: "message.sent",
    entity_kind: "message",
    entity_id: MESSAGE,
    payload: {
      message_id: MESSAGE,
      conversation_id: CONVERSATION,
      contact_id: CONTACT,
      direction: "outbound",
      status: "sent",
      body_preview: "Deixamos agendado conforme conversado, até sábado!",
    },
    metadata,
    consumed_by: [],
    attempts: 0,
  };
}

/** The CRM send: emitted by the messages handler with a thin payload. */
function crmEvent(metadata: Row = { request_id: "req-1", actor_type: "user" }): EventRow {
  return {
    ...phoneEvent(),
    id: "evt-crm",
    payload: { status: "sent", conversation_id: CONVERSATION },
    metadata,
  };
}

function stageOf(tables: Record<string, Row[]>, leadId: string): unknown {
  return tables.crm_leads!.find((l) => l.id === leadId)?.stage_id;
}

describe("message.sent: registration", () => {
  it("is declared in the single source, subscribed by the handler and labelled in the editor", () => {
    expect(TRIGGER_EVENTS as readonly string[]).toContain("message.sent");
    expect(ENTIDADE_ESPERADA_POR_GATILHO["message.sent"]).toBe("message");
    expect(automationRulesHandler.events).toContain("message.sent");
    expect(TRIGGER_LABELS["message.sent"]).toBe("Mensagem enviada pela equipe");
    expect(DICIONARIO["Mensagem enviada pela equipe"]?.es).toBeTruthy();
  });

  it("a saved rule runs: the engine finds it, records the run and bumps run_count", async () => {
    const { tables, admin } = world();
    const r = await runAutomationForEvent(admin, phoneEvent());
    expect(r).toEqual({ consumer_key: AUTOMATION_CONSUMER_KEY, status: "ok" });
    const runs = tables.automation_rule_runs ?? [];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ rule_id: RULE, event_id: "evt-phone", status: "success" });
    expect(tables.automation_rules![0]!.run_count).toBe(1);
  });
});

describe("message.sent: context", () => {
  it("the CRM send (thin payload) gets text, origin, contact and the conversation's lead from the row", async () => {
    const { admin } = world({ sentVia: "user" });
    const ctx = await buildContext(admin, crmEvent());
    expect(ctx.event).toMatchObject({
      body_preview: "Deixamos agendado conforme conversado, até sábado!",
      sent_via: "user",
      contact_id: CONTACT,
      conversation_id: CONVERSATION,
      message_id: MESSAGE,
    });
    expect((ctx.contact as Row).id).toBe(CONTACT);
    expect((ctx.lead as Row).id).toBe("lead-1");
  });

  it("the phone reply carries sent_via external_device, read from the row", async () => {
    const { admin } = world();
    const ctx = await buildContext(admin, phoneEvent());
    expect((ctx.event as Row).sent_via).toBe("external_device");
    expect((ctx.lead as Row).id).toBe("lead-1");
  });

  it("a closed lead is not the conversation's lead", async () => {
    const closed = { ...openLead("lead-old", BOOKED.id), status: "won" } as never;
    const { admin } = world({ leads: [closed] });
    const ctx = await buildContext(admin, phoneEvent());
    expect(ctx.lead).toBeUndefined();
    expect((ctx.contact as Row).id).toBe(CONTACT);
  });
});

describe("message.sent: the move happens", () => {
  it("phone reply with 'deixamos agendado' moves the lead to Horário marcado", async () => {
    const { tables, admin } = world();
    await runAutomationForEvent(admin, phoneEvent());
    expect(stageOf(tables, "lead-1")).toBe(BOOKED.id);
  });

  it("CRM send by an attendant moves it too, and add_tag tags the LEAD", async () => {
    const { tables, admin } = world({
      sentVia: "user",
      actions: [
        { type: "create_or_move_lead", config: { pipeline_id: PIPE, stage_id: BOOKED.id } },
        { type: "add_tag", config: { tags: ["agendado"] } },
      ],
    });
    await runAutomationForEvent(admin, crmEvent());
    expect(stageOf(tables, "lead-1")).toBe(BOOKED.id);
    expect(tables.crm_leads!.find((l) => l.id === "lead-1")?.tags).toEqual(["agendado"]);
  });

  it("a message without the phrase does not move it (the condition still decides)", async () => {
    const { tables, admin } = world({ body: "Qual horário fica melhor?" });
    const ev = phoneEvent();
    ev.payload.body_preview = "Qual horário fica melhor?";
    const r = await runAutomationForEvent(admin, ev);
    expect(r.detail).toBe("no_match");
    expect(stageOf(tables, "lead-1")).toBe(NEW_CONTACT.id);
  });

  it("conversation lead in another pipeline: the open lead of the target pipeline moves, no cross-pipeline failure", async () => {
    const { tables, admin } = world({
      leads: [openLead("lead-other", OTHER_STAGE.id, OTHER_PIPE), openLead("lead-1", NEW_CONTACT.id)],
    });
    await runAutomationForEvent(admin, phoneEvent());
    expect(stageOf(tables, "lead-1")).toBe(BOOKED.id);
    expect(tables.automation_rule_runs![0]).toMatchObject({ status: "success" });
  });
});

describe("message.sent: AI and automation messages are ignored by default", () => {
  it.each(["ai", "automation", "system"])("sent_via %s does not trigger the rule", async (sentVia) => {
    const { tables, admin } = world({ sentVia });
    const r = await runAutomationForEvent(admin, crmEvent({ request_id: "req-x", actor_type: "ai_agent" }));
    expect(r).toEqual({ consumer_key: AUTOMATION_CONSUMER_KEY, status: "ok", detail: "origin_not_team" });
    expect(stageOf(tables, "lead-1")).toBe(NEW_CONTACT.id);
    expect(tables.automation_rule_runs ?? []).toHaveLength(0);
  });

  it("unless the rule explicitly asks for it with an event.sent_via condition", async () => {
    const { tables, admin } = world({
      sentVia: "ai",
      conditions: [
        { field: "event.sent_via", op: "eq", value: "ai" },
        { field: "event.body_preview", op: "contains", value: "deixamos agendado" },
      ],
    });
    await runAutomationForEvent(admin, crmEvent({ request_id: "req-x", actor_type: "ai_agent" }));
    expect(stageOf(tables, "lead-1")).toBe(BOOKED.id);
  });

  it("a rule can require the CRM only: event.sent_via eq user skips the phone reply", async () => {
    const { tables, admin } = world({
      conditions: [
        { field: "event.sent_via", op: "eq", value: "user" },
        { field: "event.body_preview", op: "contains", value: "deixamos agendado" },
      ],
    });
    const r = await runAutomationForEvent(admin, phoneEvent());
    expect(r.detail).toBe("no_match");
    expect(stageOf(tables, "lead-1")).toBe(NEW_CONTACT.id);
  });

  it("ruleAcceptsOrigin: people always, anything else only with the explicit condition", () => {
    for (const via of ["user", "crm", "external_device"]) expect(ruleAcceptsOrigin([], { sent_via: via })).toBe(true);
    for (const via of ["ai", "automation", "system", undefined]) expect(ruleAcceptsOrigin([], { sent_via: via })).toBe(false);
    expect(ruleAcceptsOrigin([{ field: "event.sent_via", op: "eq", value: "ai" }], { sent_via: "ai" })).toBe(true);
  });
});

describe("message.sent: anti-loop and missing messages", () => {
  it("a message sent by a rule (request_id 'rule:') never re-triggers, even with the explicit opt-in", async () => {
    const { tables, admin } = world({
      sentVia: "automation",
      conditions: [{ field: "event.sent_via", op: "eq", value: "automation" }],
    });
    const r = await runAutomationForEvent(admin, crmEvent({ request_id: `rule:${RULE}`, actor_type: "webhook_source" }));
    expect(r).toEqual({ consumer_key: AUTOMATION_CONSUMER_KEY, status: "skipped", detail: "caused_by_rule" });
    expect(stageOf(tables, "lead-1")).toBe(NEW_CONTACT.id);
  });

  it("caused_by_rule metadata is skipped too", async () => {
    const { admin } = world();
    const r = await runAutomationForEvent(admin, phoneEvent({ caused_by_rule: RULE }));
    expect(r.detail).toBe("caused_by_rule");
  });

  it("a message row that no longer exists (deleted echo of our own send) triggers nothing", async () => {
    const { tables, admin } = world({ withMessage: false });
    const r = await runAutomationForEvent(admin, phoneEvent());
    expect(r).toEqual({ consumer_key: AUTOMATION_CONSUMER_KEY, status: "skipped", detail: "message_not_found" });
    expect(stageOf(tables, "lead-1")).toBe(NEW_CONTACT.id);
  });

  it("a send the channel refused (status failed) triggers nothing", async () => {
    const { tables, admin } = world({ sentVia: "user", status: "failed" });
    const r = await runAutomationForEvent(admin, crmEvent());
    expect(r.detail).toBe("message_not_delivered");
    expect(stageOf(tables, "lead-1")).toBe(NEW_CONTACT.id);
  });

  it("message.received keeps its context: no lead hydrated (existing rules unchanged)", async () => {
    const { admin } = world();
    const ctx = await buildContext(admin, { ...phoneEvent(), event_type: "message.received" });
    expect(ctx.lead).toBeUndefined();
    expect((ctx.contact as Row).id).toBe(CONTACT);
  });
});
