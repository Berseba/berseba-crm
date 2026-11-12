/**
 * Berseba: read-only agenda tools over Atos Clínicas, for the studio RBCOR (agent "Clara").
 *
 * RBCOR keeps its class agenda in Atos; `Berseba/berseba-rbcor` exposes a small read-only REST
 * API over it (`lib/integrations/atos/client.ts`). The CRM orchestrates; the API has no model
 * and no conversation, and it already applies the studio's rules to the free places (40-minute
 * classes on the hour, Monday to Friday, never at 13h, the plan's window, at least 1 h ahead).
 * The CRM's native agenda (`calendar_*`, `crm_find_free_slots`) is not used for this studio.
 *
 * Three rules hold for every tool here:
 *  - THE PHONE NEVER COMES FROM THE MODEL. It is the phone of `ctx.contatoDoTurno` (trusted
 *    context, injected by the runtime), read with `organization_id = ctx.organizationId`. The
 *    API only shows the classes of the student whose mobile in Atos is that phone. No contact
 *    of the turn (HTTP route, external MCP) = refused.
 *  - Only the organizations in `ATOS_API_ORG_IDS` (install level) have these tools.
 *  - Every API failure answers `{ok: false, code, handoff: true}`: the agent tells the student
 *    the front desk will continue and calls `crm_request_human_handoff`. In this phase a free
 *    place is information only; booking stays with the front desk.
 *
 * Refusals carry `permitido: false` + `motivo`, so the runtime audits them as failures
 * (`recusaDoHandler` in `lib/ai/runtime/tools.ts`): the handoffs these tools cause are counted.
 */
import { z } from "zod";

import {
  ATOS_PERIODS,
  ATOS_PLANS,
  AtosApiError,
  listBookings,
  listSlots,
  type AtosBooking,
  type AtosSlot,
} from "@/lib/integrations/atos/client";
import { atosConfigFor, type AtosConfig } from "@/lib/integrations/atos/config";
import { logger } from "@/lib/logger";

import type { McpContext, McpToolDefinition } from "../types";

/** At most this many classes go back to the model, the earliest first. */
export const MAX_SLOTS = 12;
/** The API reads at most 14 days per call. */
const MAX_RANGE_DAYS = 14;

const HANDOFF_INSTRUCTION =
  "Não tente de novo. Diga à aluna, sem falar de erro nem de sistema, que a recepção vai " +
  "verificar e já responde por aqui. Depois chame crm_request_human_handoff com um resumo do " +
  "pedido (dia, período, plano) e o que a recepção precisa fazer (o campo todo).";

/** What the front desk must do, per code; the agent puts it in the handoff summary. */
const TODO_BY_CODE: Record<string, string> = {
  student_not_found:
    "O celular desta conversa não está no Atos (aluna nova ou outro celular no cadastro): " +
    "conferir o cadastro e responder sobre as aulas.",
  ambiguous_student:
    "Duas alunas no Atos com este celular: confirmar no Atos qual é (pelo nome) e responder.",
  contato_sem_telefone: "O contato não tem telefone no CRM: consultar a agenda pelo nome.",
};
const TODO_DEFAULT = "A agenda do Atos não respondeu: consultar no Atos e responder à aluna.";

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

type Refusal = {
  ok: false;
  permitido: false;
  motivo: string;
  code: string;
  handoff: boolean;
  mensagem: string;
  todo?: string;
};

function refusal(code: string, handoff: boolean, mensagem: string): Refusal {
  return {
    ok: false,
    permitido: false,
    motivo: code,
    code,
    handoff,
    mensagem,
    ...(handoff ? { todo: TODO_BY_CODE[code] ?? TODO_DEFAULT } : {}),
  };
}

/** The phone of the turn's contact as `+<digits>`, or `null`. Never from the args. */
async function turnContactPhone(ctx: McpContext): Promise<string | null> {
  if (!ctx.contatoDoTurno) return null;
  const { data, error } = await ctx.supabase
    .from("contacts")
    .select("phone_number")
    .eq("organization_id", ctx.organizationId)
    .eq("id", ctx.contatoDoTurno)
    .maybeSingle<{ phone_number: string | null }>();
  if (error) throw new Error(`atos: contact lookup failed: ${error.message}`);
  const digits = data?.phone_number?.replace(/\D/g, "") ?? "";
  return digits.length >= 10 ? `+${digits}` : null;
}

/** Org gate + a conversation. Returns the refusal to hand the model when either is missing. */
function gate(ctx: McpContext): AtosConfig | Refusal {
  const config = atosConfigFor(ctx.organizationId);
  if (!config) {
    return refusal(
      "atos_indisponivel",
      false,
      "esta ferramenta não está disponível nesta empresa.",
    );
  }
  if (!ctx.contatoDoTurno) {
    return refusal(
      "sem_contato_do_turno",
      false,
      "esta ferramenta só funciona dentro de uma conversa com a aluna.",
    );
  }
  return config;
}

const isRefusal = (v: AtosConfig | Refusal): v is Refusal => "ok" in v;

/** Every API failure hands off; `ambiguous_student` first asks the student's name. */
function failure(err: unknown): Refusal {
  if (!(err instanceof AtosApiError)) {
    logger.warn("atos: unexpected tool failure", {
      error: err instanceof Error ? err.message : String(err),
    });
    return refusal("internal_error", true, HANDOFF_INSTRUCTION);
  }
  logger.warn("atos: API refused", { status: err.status, code: err.code });
  if (err.code === "ambiguous_student") {
    return refusal(
      err.code,
      true,
      "há duas alunas com este celular no Atos. Pergunte o nome completo da aluna; com o nome, " +
        "diga que a recepção vai verificar e chame crm_request_human_handoff com o nome e o " +
        "pedido no resumo (o campo todo). Não tente de novo.",
    );
  }
  return refusal(err.code, true, HANDOFF_INSTRUCTION);
}

const WEEKDAYS = [
  "domingo",
  "segunda-feira",
  "terça-feira",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "sábado",
];

/** The weekday of a `YYYY-MM-DD` date, in Portuguese: the agent repeats it, never computes it. */
export function weekdayOf(date: string): string | null {
  const day = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(day.getTime()) ? null : WEEKDAYS[day.getUTCDay()]!;
}

/** `13/11`: the agent repeats this, never computes it. */
const dataBr = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

/** Today in Brasília, `YYYY-MM-DD`. */
export function todayInBrasilia(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now);
}

const daysBetween = (from: string, to: string) =>
  Math.round(
    (new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86_400_000,
  );

/**
 * A range the API would refuse with 422 (`to` before `from`, more than 14 days), caught here
 * so the agent can fix its own call instead of handing off.
 */
function badRange(from: string | undefined, to: string | undefined): Refusal | null {
  if (!to) return null;
  const span = daysBetween(from ?? todayInBrasilia(), to);
  if (span < 0) {
    return refusal(
      "intervalo_invertido",
      false,
      "a data final é antes da inicial; corrija e chame de novo.",
    );
  }
  if (span >= MAX_RANGE_DAYS) {
    return refusal(
      "intervalo_longo",
      false,
      `consulte no máximo ${MAX_RANGE_DAYS} dias por vez; diminua o intervalo e chame de novo.`,
    );
  }
  return null;
}

/**
 * Only the declared arguments reach `api_audit_log`. None of them is a phone by design, but a
 * model may still send an undeclared `phone`, and a stray key would be logged as it came.
 */
function keepOnly(keys: readonly string[]) {
  return (args: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(args).filter(([k]) => keys.includes(k)));
}

const date = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "use AAAA-MM-DD")
    .optional()
    .describe(what);

// ---------------------------------------------------------------------------
// atos_free_slots
// ---------------------------------------------------------------------------

function slotView(s: AtosSlot) {
  return {
    dia_semana: weekdayOf(s.date),
    data: dataBr(s.date),
    inicio: s.start_time,
    fim: s.end_time,
    vagas: s.free,
  };
}

const freeSlotsShape = {
  from: date("Primeiro dia, AAAA-MM-DD (Brasília). Sem: hoje."),
  to: date("Último dia, inclusive. Sem from e to: hoje e amanhã."),
  plan: z
    .enum(ATOS_PLANS)
    .optional()
    .describe(
      "Plano da aluna, se souber: rbcor (planos da RBCOR), totalpass_tp2, totalpass_tp3, " +
        "wellhub_silver (Silver+ ou acima). Sem plano conhecido, não mande.",
    ),
  period: z
    .enum(ATOS_PERIODS)
    .optional()
    .describe("manha (antes das 12h) ou tarde (12h em diante)."),
};

export const atosFreeSlots: McpToolDefinition<typeof freeSlotsShape> = {
  name: "atos_free_slots",
  description:
    "Mostra horários de aula com vaga na agenda da RBCOR (Atos), até 12, os mais cedo primeiro. " +
    "Use sempre que a aluna perguntar por horário ou vaga; nunca invente horário nem vaga. " +
    "Aulas de 40 min, começando na hora cheia, de segunda a sexta, nunca às 13h. Faixa por " +
    "plano: TotalPass TP2 das 8h às 17h; TP3, Wellhub Silver+ e planos RBCOR das 6h às 19h. " +
    "Para o mesmo dia, só até 1 h antes. A ferramenta já aplica essas regras: repita o que vier. " +
    "Mande plan pelo que a aluna disse ou pela etiqueta do contato. A vaga é informação: quem " +
    "confirma a aula é a recepção. Nunca diga com qual instrutora a aluna vai ficar.",
  inputSchema: freeSlotsShape,
  redigirParaAuditoria: keepOnly(Object.keys(freeSlotsShape)),
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  motivoDoVazio: (r) =>
    typeof r === "object" && r !== null && (r as { total?: unknown }).total === 0
      ? "sem_vagas"
      : null,
  handler: async (input, ctx) => {
    const config = gate(ctx);
    if (isRefusal(config)) return config;
    const range = badRange(input.from, input.to);
    if (range) return range;
    try {
      const slots = await listSlots(config, {
        from: input.from,
        to: input.to,
        plan: input.plan,
        period: input.period,
      });
      const sorted = [...slots].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
      return {
        ok: true,
        aulas: sorted.slice(0, MAX_SLOTS).map(slotView),
        total: slots.length,
        ...(slots.length > MAX_SLOTS ? { mais_horarios: true } : {}),
        aviso: "vaga não é aula marcada: quem confirma é a recepção.",
      };
    } catch (err) {
      return failure(err);
    }
  },
};

// ---------------------------------------------------------------------------
// atos_my_classes
// ---------------------------------------------------------------------------

function bookingView(b: AtosBooking) {
  return {
    dia_semana: weekdayOf(b.date),
    data: dataBr(b.date),
    inicio: b.start_time,
    fim: b.end_time,
    status: b.status,
    status_atos: b.atos_status,
  };
}

const myClassesShape = {
  from: date("Primeiro dia, AAAA-MM-DD (Brasília). Sem: hoje."),
  to: date("Último dia, inclusive. Sem: 13 dias depois de from."),
};

export const atosMyClasses: McpToolDefinition<typeof myClassesShape> = {
  name: "atos_my_classes",
  description:
    "Lista as próximas aulas da aluna DESTA conversa na agenda da RBCOR (Atos), pelo telefone " +
    "do contato: você não informa telefone. Sem datas, de hoje até 13 dias à frente (no máximo " +
    "14 dias; o Atos traz só as próximas 10 aulas). Use quando a aluna perguntar quando é a aula " +
    'dela. Fale dia e horário. Sobre o status, não afirme nada além de "aula marcada" ' +
    "(o significado de cada status ainda não foi confirmado). Falta, troca e reposição são com " +
    "a recepção. Nunca diga com qual instrutora é a aula.",
  inputSchema: myClassesShape,
  redigirParaAuditoria: keepOnly(Object.keys(myClassesShape)),
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  motivoDoVazio: (r) =>
    typeof r === "object" && r !== null && (r as { total?: unknown }).total === 0
      ? "sem_aulas"
      : null,
  handler: async (input, ctx) => {
    const config = gate(ctx);
    if (isRefusal(config)) return config;
    const range = badRange(input.from, input.to);
    if (range) return range;
    const phone = await turnContactPhone(ctx);
    if (!phone) {
      return refusal(
        "contato_sem_telefone",
        true,
        "não sei o telefone desta aluna, então não consigo consultar as aulas. " +
          HANDOFF_INSTRUCTION,
      );
    }
    try {
      // Field by field, never a spread: nothing in the args may reach the API as the phone.
      const bookings = await listBookings(config, { phone, from: input.from, to: input.to });
      const sorted = [...bookings].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
      return { ok: true, aulas: sorted.map(bookingView), total: bookings.length };
    } catch (err) {
      return failure(err);
    }
  },
};
