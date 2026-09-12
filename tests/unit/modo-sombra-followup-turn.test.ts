/**
 * MODO SOMBRA no envio fixo do follow-up (`sendFixedOutbound`).
 *
 * `sendFixedOutbound` é o funil dos DOIS follow-ups sem LLM (re-entrada por
 * TEMPLATE e texto de FLUXO — ver `camada-semantica-no-envio-fixo.test.ts`
 * para o motivo de serem uma função só). Nenhum dos dois passa pelo cinto de
 * segurança do turno rico (`executarTurnoDoAgente`), então precisam do
 * próprio gate — este arquivo garante que ele existe e barra os DOIS.
 *
 * Harness copiado de `camada-semantica-no-envio-fixo.test.ts` (mesmo pool
 * fake, mesmos mocks de `runBeforeSend`/handoff/contexto) — muda só o que
 * `lerModoSombra` devolve.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobRow } from "@/lib/agent-engine/queue/queue";

const runBeforeSend = vi.fn(async (_args: Record<string, unknown>) => ({
  status: "sent",
  outcome: {},
  trace: [],
}));
vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({ runBeforeSend }));

vi.mock("@/lib/agent-engine/agent/human-handoff", () => ({
  isLeadInHandoff: vi.fn(async () => false),
}));

vi.mock("@/lib/agent-engine/edge/crm/get-lead-context", () => ({
  getLeadContext: vi.fn(async () => ({
    ok: true,
    context: { contact: { is_blocked: false } },
    lgpd: { isAnonymized: false, isProspecting: false, legalBasis: {} },
  })),
}));

vi.mock("@/lib/agent-engine/agent/reentry-template", () => ({
  loadReentryTemplate: vi.fn(async () => ({ variants: ["oi, tudo bem?"] })),
  pickReentryVariant: vi.fn(() => "oi, tudo bem?"),
}));

vi.mock("@/lib/agent-engine/edge/crm/send-message", () => ({
  applySendOutcome: vi.fn(async () => undefined),
}));

const lerModoSombra = vi.fn(async () => ({ org: false, canal: false }));
vi.mock("@/lib/ai/modo-sombra", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  lerModoSombra,
}));

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const CANAL = "canal-1";

const boundary = { organization_id: ORG, contact_id: LEAD, conversation_id: CONVERSA, service_revision: 1, demanda_id: null, demanda_revision: null };

function job(payload: Record<string, unknown>): JobRow {
  return {
    id: "job-1",
    organization_id: ORG,
    contact_id: LEAD,
    kind: "followup_turn",
    source_event_id: null,
    payload: { ...payload, service_boundary: boundary },
    status: "running",
    priority: 0,
    run_after: new Date(),
    attempts: 1,
    max_attempts: 3,
    last_error: null,
    locked_by: "w1",
    locked_at: new Date(),
    created_at: new Date(),
  } as JobRow;
}

function fakePool() {
  const query = vi.fn(async (sql: string): Promise<{ rows: Array<Record<string, unknown>> }> => {
    if (sql.includes("d.fechada_em::text")) return { rows: [{ ...boundary, status: "open", demanda_fechada_em: null }] };
    if (/from org_guardrail_layers/.test(sql)) return { rows: [{ layer: "promessa_semantica", enabled: false }] };
    if (/from conversations/.test(sql)) return { rows: [{ id: CONVERSA, channel_session_id: CANAL, archived_at: null }] };
    return { rows: [] };
  });
  return { pool: { query } as never, query };
}

const ctx = { workerId: "w1" };

function deps() {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    crmCfg: {},
    llmCfg: {},
    knobs: { promiseSemantic: { enabled: false } },
    channel: () => ({ send: vi.fn(async () => ({ ok: true })) }),
    completeFollowupTurn: vi.fn(async () => undefined),
  } as never;
}

let criarHandler: typeof import("@/lib/agent-engine/agent/followup-turn").createFollowupTurnHandler;

beforeAll(async () => {
  ({ createFollowupTurnHandler: criarHandler } = await import(
    "@/lib/agent-engine/agent/followup-turn"
  ));
}, 60_000);

beforeEach(() => {
  runBeforeSend.mockClear();
  lerModoSombra.mockClear();
  lerModoSombra.mockResolvedValue({ org: false, canal: false });
});

describe("modo sombra barra o envio fixo do follow-up (os dois chamadores)", () => {
  it("org em sombra + re-entrada por TEMPLATE: não envia", async () => {
    lerModoSombra.mockResolvedValue({ org: true, canal: false });
    const { pool } = fakePool();
    await criarHandler(deps())(job({ mode: "template" }), pool, ctx);
    expect(runBeforeSend).not.toHaveBeenCalled();
  });

  it("canal em sombra + texto de FLUXO (fixed_body): não envia", async () => {
    lerModoSombra.mockResolvedValue({ org: false, canal: true });
    const { pool } = fakePool();
    await criarHandler(deps())(
      job({
        followup_enrollment_id: "11111111-1111-4111-8111-111111111111",
        node_id: "node-1",
        purpose: "send_message",
        fixed_body: "oi, tudo bem?",
      }),
      pool,
      ctx,
    );
    expect(runBeforeSend).not.toHaveBeenCalled();
  });

  it("nem org nem canal em sombra: envia normalmente (controle positivo)", async () => {
    lerModoSombra.mockResolvedValue({ org: false, canal: false });
    const { pool } = fakePool();
    await criarHandler(deps())(job({ mode: "template" }), pool, ctx);
    expect(runBeforeSend).toHaveBeenCalledTimes(1);
  });

  it("consulta ao módulo de modo sombra recebe org e canal corretos", async () => {
    const { pool } = fakePool();
    await criarHandler(deps())(job({ mode: "template" }), pool, ctx);
    expect(lerModoSombra).toHaveBeenCalledWith(pool, { organizationId: ORG, channelSessionId: CANAL });
  });
});
