/**
 * Berseba: agenda tools over Atos Clínicas, for the studio RBCOR (agent "Clara").
 *
 * RBCOR keeps its class agenda in Atos; `Berseba/berseba-rbcor` exposes a small REST API over it (`lib/integrations/atos/client.ts`). The CRM orchestrates; the API has no model
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
 *  - An API failure the agent cannot fix answers `{ok: false, code, handoff: true}`: the agent
 *    tells the student the front desk will continue and calls `crm_request_human_handoff`. The
 *    two it can fix: `slot_unavailable` (search again, once) and `rule_violation` (repeat the
 *    studio's rule, in `detail`). Writes are never retried: a lost answer may mean Atos wrote it.
 *
 * Reads (`atos_free_slots`, `atos_my_classes`) and writes (`atos_cancel_class`,
 * `atos_reschedule_class`, `atos_book_makeup`, `atos_book_class`, `atos_book_trial`,
 * `atos_create_recurring_plan`) are separate
 * switches on the agent screen; the writes are `critico`, so no bundle ever turns them on.
 *
 * Refusals carry `permitido: false` + `motivo`, so the runtime audits them as failures
 * (`recusaDoHandler` in `lib/ai/runtime/tools.ts`): the handoffs these tools cause are counted.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import {
  ATOS_PERIODS,
  ATOS_PLANS,
  AtosApiError,
  ATOS_APP_PLANS,
  ATOS_WEEKDAYS,
  bookClass,
  bookMakeup,
  createRecurringPlan,
  bookTrial,
  cancelBooking,
  listBookings,
  listSlots,
  rescheduleBooking,
  type AtosAppPlan,
  type AtosBooking,
  type AtosSlot,
  type AtosWriteResult,
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
  not_found: "A aula citada não foi achada para este celular no Atos: conferir com a aluna.",
  not_enabled: "Esta alteração ainda não está ligada na ponte do Atos: fazer manualmente.",
  slot_unavailable: "Os horários oferecidos foram ocupados: oferecer outro horário à aluna.",
  atos_write_unconfirmed:
    "Conferir no Atos se a alteração entrou; não repetir pelo sistema. Se não entrou, fazer manualmente.",
  sem_chave_de_idempotencia: "Fazer manualmente no Atos o que a aluna pediu.",
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
  detail?: string;
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

const isRefusal = <T extends object>(v: T | Refusal): v is Refusal => "ok" in v;

/**
 * Every API failure hands off, except the two the agent fixes itself: `rule_violation` (it
 * repeats the studio's rule) and the first `slot_unavailable` (it searches again).
 * `ambiguous_student` first asks the student's name. For a write, no answer (or
 * `atos_write_unconfirmed`) may mean Atos wrote it: the front desk checks, nothing is repeated.
 */
function failure(
  err: unknown,
  options: { isWrite?: boolean; slotTakenTwice?: boolean } = {},
): Refusal {
  if (!(err instanceof AtosApiError)) {
    logger.warn("atos: unexpected tool failure", {
      error: err instanceof Error ? err.message : String(err),
    });
    return refusal("internal_error", true, HANDOFF_INSTRUCTION);
  }
  logger.warn("atos: API refused", { status: err.status, code: err.code });
  if (err.code === "rule_violation") {
    return {
      ...refusal(
        err.code,
        false,
        "o estúdio não permite essa alteração. Explique à aluna, com suas palavras, a regra em " +
          "detail e ofereça o que for possível. Não transfira e não tente de novo igual.",
      ),
      detail: err.detail ?? "",
    };
  }
  if (err.code === "slot_unavailable" && !options.slotTakenTwice) {
    return refusal(
      err.code,
      false,
      "alguém acabou de pegar esse horário. Busque de novo com atos_free_slots, ofereça outro " +
        "horário à aluna e confirme antes de gravar.",
    );
  }
  // No HTTP answer to a write is the same as `atos_write_unconfirmed`: Atos may have written it.
  // Other 5xx (`not_enabled`, `atos_login_failed`, …) answer before any write.
  const unconfirmed =
    err.code === "atos_write_unconfirmed" || (options.isWrite === true && err.status === 0);
  if (unconfirmed) {
    return {
      ...refusal(
        "atos_write_unconfirmed",
        true,
        "o Atos pode ter gravado essa alteração, mas a resposta se perdeu. NUNCA repita. " +
          HANDOFF_INSTRUCTION,
      ),
      motivo: err.code,
      code: err.code,
    };
  }
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
    slot_id: s.id,
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
    "Mande plan pelo que a aluna disse ou pela etiqueta do contato. O slot_id é o que as " +
    "ferramentas de marcar pedem; sem elas, a vaga é só informação e quem marca é a recepção. " +
    "Nunca diga com qual instrutora a aluna vai ficar.",
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
    booking_id: b.id,
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
    "(o significado de cada status ainda não foi confirmado). O booking_id é o que as " +
    "ferramentas de desmarcar, remarcar e reposição pedem; sem elas, isso é com a recepção. " +
    "Nunca diga com qual instrutora é a aula.",
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

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

const SLOT_TAKEN_TTL_MS = 30 * 60_000;

const CONFIRM_FIRST =
  'Antes de chamar, confirme com a aluna o dia e o horário ("Confirma sexta às 7h?") e só ' +
  "chame depois do sim dela.";

/**
 * The `Idempotency-Key` of a write: stable per intended write, so a retry of the same turn
 * replays the first answer instead of writing twice. The job id is the conversation's turn; the
 * args hash is in the key because in one turn the agent may try a second slot after the first
 * was taken, and one key with two bodies is a different write. The phone is not hashed: it
 * comes from the turn's contact, the same for the whole job.
 */
export function atosIdempotencyKey(ctx: McpContext, tool: string, args: unknown): string | null {
  const job = ctx.sourceJobId ?? ctx.idempotencyKey;
  if (!job) return null;
  const hash = createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 16);
  return `atos:${job}:${tool}:${hash}`.slice(0, 128);
}

/** One `slot_unavailable` per contact is retried by the agent; the second one hands off. */
const slotTaken = new Map<string, number>();

function slotTakenBefore(ctx: McpContext): boolean {
  const key = `${ctx.organizationId}:${ctx.contatoDoTurno}`;
  const now = Date.now();
  for (const [k, at] of slotTaken) if (now - at > SLOT_TAKEN_TTL_MS) slotTaken.delete(k);
  const before = slotTaken.has(key);
  slotTaken.set(key, now);
  return before;
}

export function resetAtosSlotTakenForTests(): void {
  slotTaken.clear();
}

/** Gate, trusted phone and idempotency key: what every write needs before it calls the API. */
async function prepareWrite(
  ctx: McpContext,
  tool: string,
  args: unknown,
): Promise<{ config: AtosConfig; phone: string; key: string } | Refusal> {
  const config = gate(ctx);
  if (isRefusal(config)) return config;
  const key = atosIdempotencyKey(ctx, tool, args);
  if (!key) {
    return refusal(
      "sem_chave_de_idempotencia",
      true,
      "não consigo garantir que esta alteração não seja gravada duas vezes. " + HANDOFF_INSTRUCTION,
    );
  }
  const phone = await turnContactPhone(ctx);
  if (!phone) {
    return refusal(
      "contato_sem_telefone",
      true,
      "não sei o telefone desta aluna, então não consigo alterar a agenda. " + HANDOFF_INSTRUCTION,
    );
  }
  return { config, phone, key };
}

async function write(
  ctx: McpContext,
  run: () => Promise<AtosWriteResult>,
  done: string,
): Promise<Record<string, unknown>> {
  try {
    const result = await run();
    return {
      ok: true,
      ...(result.booking ? { aula: bookingView(result.booking) } : {}),
      ...(result.bookings ? { aulas: result.bookings.map(bookingView) } : {}),
      ...(result.student_created === undefined ? {} : { cadastro_novo: result.student_created }),
      ...(result.makeup_eligible === undefined ? {} : { tem_reposicao: result.makeup_eligible }),
      mensagem: done,
    };
  } catch (err) {
    const twice =
      err instanceof AtosApiError && err.code === "slot_unavailable" && slotTakenBefore(ctx);
    return failure(err, { isWrite: true, slotTakenTwice: twice });
  }
}

const bookingId = (what: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}-\d{4}$/, "use o booking_id de atos_my_classes")
    .describe(what);

const slotId = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}-\d{4}$/, "use o slot_id de atos_free_slots")
  .describe("O slot_id do horário escolhido, de atos_free_slots.");

const freeText = (what: string) => z.string().trim().max(300).optional().describe(what);

/** Free text and personal data the student gave never reach `api_audit_log`. */
function redactFields(keys: readonly string[], fields: readonly string[]) {
  const keep = keepOnly(keys);
  return (args: Record<string, unknown>) => {
    const out = keep(args);
    for (const f of fields) if (f in out) out[f] = "[redacted]";
    return out;
  };
}

// ---- atos_cancel_class ----------------------------------------------------

const cancelShape = {
  booking_id: bookingId("O booking_id da aula, de atos_my_classes."),
  reason: freeText("O motivo em poucas palavras, se a aluna disse."),
};

export const atosCancelClass: McpToolDefinition<typeof cancelShape> = {
  name: "atos_cancel_class",
  description:
    "Desmarca UMA AULA da aluna DESTA conversa no Atos, nunca o plano; serve também para avisar " +
    "falta (no Atos as duas são Desmarcado). Cancelar plano ou contrato é sempre da equipe: " +
    "faça handoff com o resumo. Se não estiver claro se ela fala da aula ou do plano, pergunte " +
    "antes. Use o booking_id de atos_my_classes; se tiver mais de uma aula, pergunte qual. " +
    CONFIRM_FIRST +
    " A resposta diz se a aula dá direito a reposição (tem_reposicao); se sim, ofereça marcar " +
    "com atos_book_makeup.",
  inputSchema: cancelShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  redigirParaAuditoria: redactFields(Object.keys(cancelShape), ["reason"]),
  handler: async (input, ctx) => {
    const ready = await prepareWrite(ctx, "atos_cancel_class", input);
    if (isRefusal(ready)) return ready;
    const { config, phone, key } = ready;
    return write(
      ctx,
      () =>
        cancelBooking(config, {
          bookingId: input.booking_id,
          phone,
          reason: input.reason,
          idempotencyKey: key,
        }),
      "aula desmarcada. Confirme à aluna o dia e o horário desmarcados.",
    );
  },
};

// ---- atos_reschedule_class ------------------------------------------------

const rescheduleShape = {
  booking_id: bookingId("O booking_id da aula que muda, de atos_my_classes."),
  slot_id: slotId,
};

export const atosRescheduleClass: McpToolDefinition<typeof rescheduleShape> = {
  name: "atos_reschedule_class",
  description:
    "Troca o horário de uma aula da aluna DESTA conversa no Atos: a aula do booking_id (de " +
    "atos_my_classes) vai para o slot_id (de atos_free_slots). " +
    CONFIRM_FIRST,
  inputSchema: rescheduleShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  redigirParaAuditoria: keepOnly(Object.keys(rescheduleShape)),
  handler: async (input, ctx) => {
    const ready = await prepareWrite(ctx, "atos_reschedule_class", input);
    if (isRefusal(ready)) return ready;
    const { config, phone, key } = ready;
    return write(
      ctx,
      () =>
        rescheduleBooking(config, {
          bookingId: input.booking_id,
          phone,
          slotId: input.slot_id,
          idempotencyKey: key,
        }),
      "aula remarcada. Confirme à aluna o novo dia e horário.",
    );
  },
};

// ---- atos_book_makeup -----------------------------------------------------

const makeupShape = {
  missed_booking_id: bookingId(
    "O booking_id da aula desmarcada que dá direito à reposição (de atos_cancel_class ou atos_my_classes).",
  ),
  slot_id: slotId,
};

export const atosBookMakeup: McpToolDefinition<typeof makeupShape> = {
  name: "atos_book_makeup",
  description:
    "Marca a reposição de uma aula desmarcada da aluna DESTA conversa no Atos, no slot_id de " +
    "atos_free_slots. A regra de quem tem direito e do prazo é do Atos: se vier recusa, " +
    "explique. " +
    CONFIRM_FIRST,
  inputSchema: makeupShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  redigirParaAuditoria: keepOnly(Object.keys(makeupShape)),
  handler: async (input, ctx) => {
    const ready = await prepareWrite(ctx, "atos_book_makeup", input);
    if (isRefusal(ready)) return ready;
    const { config, phone, key } = ready;
    return write(
      ctx,
      () =>
        bookMakeup(config, {
          phone,
          missedBookingId: input.missed_booking_id,
          slotId: input.slot_id,
          idempotencyKey: key,
        }),
      "reposição marcada. Confirme à aluna o dia e o horário.",
    );
  },
};

// ---- atos_book_class ------------------------------------------------------

const personName = z
  .string()
  .trim()
  .min(3)
  .max(120)
  .describe("Nome completo, como a pessoa escreveu.");
const birthDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "use AAAA-MM-DD")
  .describe("Data de nascimento, AAAA-MM-DD.");

/** Personal data and free text the student gave never reach `api_audit_log`. */
const PERSONAL = ["name", "birth_date", "pregnant", "needs"] as const;

const APP_CHOICE =
  "Quem vem por TotalPass ou Wellhub escolhe entre aula pontual (atos_book_class) e horários " +
  "fixos (atos_create_recurring_plan); a unidade trabalha com horários fixos.";

const bookShape = {
  slot_id: slotId,
  name: personName.optional(),
  birth_date: birthDate.optional(),
  plan: z
    .enum(ATOS_PLANS)
    .optional()
    .describe("rbcor, totalpass_tp2, totalpass_tp3 ou wellhub_silver (Silver+)."),
};

export const atosBookClass: McpToolDefinition<typeof bookShape> = {
  name: "atos_book_class",
  description:
    "Marca uma aula pontual (avulsa) para a pessoa DESTA conversa no slot_id de atos_free_slots, " +
    "buscado com o plano dela. Pessoa nova no Atos leva name e birth_date (pergunte; nunca " +
    "invente). Mande plan quando a pessoa disser o aplicativo ou a etiqueta do contato mostrar " +
    "(sem plan, pessoa nova entra como plano RBCOR). " +
    APP_CHOICE +
    " " +
    CONFIRM_FIRST +
    " No fim, lembre a política de faltas.",
  inputSchema: bookShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  redigirParaAuditoria: redactFields(Object.keys(bookShape), PERSONAL),
  handler: async (input, ctx) => {
    const ready = await prepareWrite(ctx, "atos_book_class", input);
    if (isRefusal(ready)) return ready;
    const { config, phone, key } = ready;
    return write(
      ctx,
      () =>
        bookClass(config, {
          phone,
          slotId: input.slot_id,
          name: input.name,
          birthDate: input.birth_date,
          plan: input.plan,
          idempotencyKey: key,
        }),
      "aula marcada. Confirme à pessoa o dia e o horário e lembre a política de faltas.",
    );
  },
};

// ---- atos_book_trial ------------------------------------------------------

const trialShape = {
  name: personName,
  birth_date: birthDate,
  slot_id: slotId,
  pregnant: z.boolean().optional().describe("true se a pessoa disse que está grávida."),
  needs: freeText("Dor, lesão ou cuidado que a pessoa contou, em poucas palavras."),
};

export const atosBookTrial: McpToolDefinition<typeof trialShape> = {
  name: "atos_book_trial",
  description:
    "Marca a primeira vivência de quem vai entrar num plano da RBCOR (não TotalPass nem " +
    "Wellhub): cadastra no Atos com o telefone DESTA conversa e agenda no slot_id de " +
    "atos_free_slots. Pergunte antes o nome completo e a data de nascimento; nunca invente. " +
    CONFIRM_FIRST +
    " No fim, lembre a política de faltas.",
  inputSchema: trialShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  redigirParaAuditoria: redactFields(Object.keys(trialShape), PERSONAL),
  handler: async (input, ctx) => {
    const ready = await prepareWrite(ctx, "atos_book_trial", input);
    if (isRefusal(ready)) return ready;
    const { config, phone, key } = ready;
    return write(
      ctx,
      () =>
        bookTrial(config, {
          phone,
          name: input.name,
          birthDate: input.birth_date,
          slotId: input.slot_id,
          pregnant: input.pregnant,
          needs: input.needs,
          idempotencyKey: key,
        }),
      "vivência marcada. Confirme à pessoa o dia e o horário e lembre a política de faltas.",
    );
  },
};

// ---- atos_create_recurring_plan -------------------------------------------

/** Days per week each app plan allows (Beatriz, 2026-11-12): TP3 three, TP2+ and Wellhub two. */
export const MAX_WEEKLY_BY_PLAN: Record<AtosAppPlan, number> = {
  totalpass_tp2: 2,
  totalpass_tp3: 3,
  wellhub_silver: 2,
};

const recurringShape = {
  name: personName,
  birth_date: birthDate,
  plan: z
    .enum(ATOS_APP_PLANS)
    .describe("totalpass_tp2, totalpass_tp3 ou wellhub_silver (Silver+)."),
  weekly: z
    .array(
      z.object({
        weekday: z.enum(ATOS_WEEKDAYS).describe("monday a friday."),
        start_time: z
          .string()
          .regex(/^\d{2}:\d{2}$/, "use HH:MM")
          .describe("Início, HH:MM (hora cheia)."),
      }),
    )
    .min(1)
    .max(3)
    .describe("Os horários fixos da semana: até 2 dias (TP2+ e Wellhub) ou 3 (TP3)."),
  months: z.number().int().min(1).max(12).optional().describe("Duração em meses. Sem: 12."),
};

export const atosCreateRecurringPlan: McpToolDefinition<typeof recurringShape> = {
  name: "atos_create_recurring_plan",
  description:
    "Cria os horários fixos semanais de quem vem por TotalPass ou Wellhub, para a pessoa DESTA " +
    "conversa (cadastra no Atos se for nova): por padrão 12 meses, com até 2 dias por semana " +
    "(TP2+ e Wellhub) ou 3 (TP3), na faixa do plano. Confira as vagas antes com atos_free_slots " +
    "e o mesmo plan. " +
    APP_CHOICE +
    ' Antes de chamar, confirme com a pessoa os dias e o horário ("Confirma segunda e quarta ' +
    'às 7h?") e só chame depois do sim. No fim, lembre a política de faltas.',
  inputSchema: recurringShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  redigirParaAuditoria: redactFields(Object.keys(recurringShape), PERSONAL),
  handler: async (input, ctx) => {
    const ready = await prepareWrite(ctx, "atos_create_recurring_plan", input);
    if (isRefusal(ready)) return ready;
    const max = MAX_WEEKLY_BY_PLAN[input.plan];
    if (input.weekly.length > max) {
      return refusal(
        "dias_demais",
        false,
        `esse plano permite até ${max} dias por semana; peça à pessoa para escolher e chame de novo.`,
      );
    }
    const { config, phone, key } = ready;
    return write(
      ctx,
      () =>
        createRecurringPlan(config, {
          phone,
          name: input.name,
          birthDate: input.birth_date,
          plan: input.plan,
          weekly: input.weekly,
          months: input.months,
          idempotencyKey: key,
        }),
      "horários fixos criados. Confirme à pessoa os dias e o horário e lembre a política de faltas.",
    );
  },
};
