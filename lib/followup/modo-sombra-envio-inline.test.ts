/**
 * MODO SOMBRA no envio INLINE de texto fixo (`enviarTextoFixoPendente`).
 *
 * Irmão do `enviar-texto-fixo.test.ts` (mesmo atalho, mesma razão: bypassa
 * `executarTurnoDoAgente` por completo, "sem cron e sem agent-worker" — então
 * precisa checar o cinto de segurança por conta própria, como já checa a
 * elegibilidade).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageHandler = vi.fn(async (..._a: unknown[]) => ({ id: "msg-1", status: "sent" }));
const decidir = vi.fn();
const completeTurnForEnrollment = vi.fn(async (..._a: unknown[]) => {});
const { lerModoSombra } = vi.hoisted(() => ({
  lerModoSombra: vi.fn(async () => ({ org: false, canal: false })),
}));

vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: (...a: unknown[]) => sendMessageHandler(...a) }));
vi.mock("@/lib/automation/start-conversation", () => ({
  ensureConversation: async () => "conv-1",
  sessaoProntaParaEnvio: async () => "sess-1",
}));
vi.mock("@/lib/ai/elegibilidade/consulta-supabase", () => ({
  decidirElegibilidadeDaConversaViaSupabase: (...a: unknown[]) => decidir(...a),
}));
vi.mock("@/lib/ai/modo-sombra", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  lerModoSombra,
}));
vi.mock("@/lib/followup/turn-bridge", () => ({
  completeTurnForEnrollment: (...a: unknown[]) => completeTurnForEnrollment(...a),
}));
vi.mock("@/lib/followup/engine", () => ({ createSupabaseAdminClient: () => ({}) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { enviarTextoFixoPendente } from "./enviar-texto-fixo";

const boundary = { organization_id: "org-1", contact_id: "contact-1", conversation_id: "conv-1", service_revision: 1, demanda_id: null, demanda_revision: null };
const JOB = {
  id: "job-1",
  organization_id: "org-1",
  contact_id: "contact-1",
  payload: { service_boundary: boundary, fixed_body: "Oi, tudo bem?", followup_enrollment_id: "enr-1", node_id: "node-1" },
};

const statusUpdates: string[] = [];

/** Admin stub: job_queue (select pending / claim / status) + followup_enrollments + conversations. */
function admin() {
  const make = (table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      _table: table,
      _upd: null as Record<string, unknown> | null,
      select: () => chain,
      eq: () => chain,
      lte: () => chain,
      in: () => chain,
      single: () => Promise.resolve({data:table==="send_ledger"?{id:"ledger-1"}:{settings:{}},error:null}),
      insert: () => chain,
      order: () => chain,
      limit: () => chain,
      update: (p: Record<string, unknown>) => {
        chain._upd = p;
        if (table === "job_queue" && typeof p.status === "string") statusUpdates.push(p.status);
        return chain;
      },
      maybeSingle: () => {
        if (table === "job_queue" && chain._upd) return Promise.resolve({ data: { id: JOB.id, locked_by:chain._upd.locked_by, locked_at:chain._upd.locked_at }, error: null });
        if (table === "followup_enrollments")
          return Promise.resolve({ data: { current_node_id: "node-1",status:"active",revision:1 }, error: null });
        if (table === "conversations")
          return Promise.resolve({ data: { channel_session_id: "canal-1" }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then: (r: (v: unknown) => unknown) => {
        if (table === "job_queue" && !chain._upd) {
          return Promise.resolve({ data: [JOB], error: null }).then(r);
        }
        return Promise.resolve({ data: null, error: null }).then(r);
      },
    };
    return chain;
  };
  return { from: (t: string) => make(t), rpc: async (name:string,args:Record<string,unknown>) => {
    if(name==="fn_followup_inline_settle") {statusUpdates.push(args.p_done?"done":"pending");return {data:true,error:null};}
    if(name==="fn_appointment_enrollment_current" || name==="fn_followup_job_current") return {data:true,error:null};
    return {data:{...boundary,status:"open",demanda_fechada_em:null},error:null};
  }} as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  statusUpdates.length = 0;
  lerModoSombra.mockResolvedValue({ org: false, canal: false });
  decidir.mockResolvedValue({ permite: true, motivo: "autorizado", bloqueioPorAllowlist: false });
});

describe("enviarTextoFixoPendente · modo sombra", () => {
  it("organização em sombra → NÃO envia, job vira 'done'", async () => {
    lerModoSombra.mockResolvedValue({ org: true, canal: false });
    const enviados = await enviarTextoFixoPendente(admin());
    expect(enviados).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(statusUpdates).toContain("done");
  });

  it("canal em sombra → NÃO envia, job vira 'done'", async () => {
    lerModoSombra.mockResolvedValue({ org: false, canal: true });
    const enviados = await enviarTextoFixoPendente(admin());
    expect(enviados).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(statusUpdates).toContain("done");
  });

  it("nem org nem canal em sombra → envia normalmente (controle positivo)", async () => {
    const enviados = await enviarTextoFixoPendente(admin());
    expect(enviados).toBe(1);
    expect(sendMessageHandler).toHaveBeenCalledOnce();
  });

  it("consulta ao módulo de modo sombra recebe organização e canal", async () => {
    await enviarTextoFixoPendente(admin());
    expect(lerModoSombra).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: "org-1", channelSessionId: "canal-1" }),
    );
  });
});
