/**
 * Berseba: agenda tools over avec, for the salon Mayara Morales (agent "Maya").
 *
 * The salon keeps its agenda in avec.app; `Berseba/berseba-mayara-morales` exposes a small REST
 * API over it (`lib/integrations/avec/client.ts`). The CRM's native agenda (`calendar_*`,
 * `agendamento.ts`) is not used for this salon.
 *
 * Three rules hold for every tool here:
 *  - THE PHONE NEVER COMES FROM THE MODEL. It is the phone of `ctx.contatoDoTurno` (trusted
 *    context, injected by the runtime), read with `organization_id = ctx.organizationId`. The
 *    API only shows and changes appointments of that phone, so an appointment id of another
 *    client answers 404. No contact of the turn (HTTP route, external MCP) = refused.
 *  - Only the organizations in `AVEC_API_ORG_IDS` (install level) have these tools.
 *  - A failure the agent cannot fix answers `{ok: false, code, handoff: true}`: the agent tells
 *    the client a person will continue and calls `crm_request_human_handoff`. The writes are
 *    never retried with a new key: a lost answer may mean avec wrote it.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import {
  AvecApiError,
  cancelAppointment,
  createAppointment,
  listAppointments,
  listAvailability,
  listProfessionals,
  rescheduleAppointment,
  type AvecAppointment,
  type AvecProfessional,
} from "@/lib/integrations/avec/client";
import { avecConfigFor, type AvecConfig } from "@/lib/integrations/avec/config";
import { logger } from "@/lib/logger";

import type { McpContext, McpToolDefinition } from "../types";

const MAX_SERVICES = 15;
const MAX_SLOTS = 12;
const PROFESSIONALS_TTL_MS = 5 * 60_000;
const SLOT_TAKEN_TTL_MS = 30 * 60_000;

// Same wording as "Quando passa para a Ruth" in the avec API's docs/integracao-crm.md.
const HANDOFF_INSTRUCTION =
  "Não tente de novo. Diga à cliente, sem falar de erro nem de sistema, que a Ruth da recepção " +
  "vai finalizar e já responde por aqui. Depois chame crm_request_human_handoff com um resumo: " +
  "o pedido (serviço, dia, hora, profissional) e o que a Ruth precisa fazer no avec (o campo todo).";

/** What Ruth must do in avec, per code; the agent puts it in the handoff summary. */
const TODO_BY_CODE: Record<string, string> = {
  client_not_found:
    "Cliente nova: cadastrar no avec (nome e telefone do WhatsApp) e agendar o pedido.",
  ambiguous_client: "Duas fichas no avec com este telefone: confirmar quem é e fazer o pedido.",
  slot_unavailable: "Os horários oferecidos foram ocupados: oferecer outro horário.",
  not_allowed: "A cliente quer mudar um agendamento que já começou ou passou: verificar com ela.",
  ambiguous_appointment:
    "A cliente tem dois agendamentos iguais no mesmo dia: verificar qual remarcar ou cancelar.",
  avec_write_unconfirmed: "Conferir no avec se a alteração entrou; não repetir pelo sistema.",
  contato_sem_telefone:
    "O contato não tem telefone no CRM: consultar a agenda pelo nome e fazer o pedido.",
};
const TODO_DEFAULT = "O avec não respondeu: fazer manualmente o que a cliente pediu.";

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

type Refusal = {
  ok: false;
  permitido: false;
  motivo: string;
  handoff: boolean;
  mensagem: string;
  todo?: string;
};

function refusal(motivo: string, handoff: boolean, mensagem: string): Refusal {
  return {
    ok: false,
    permitido: false,
    motivo,
    handoff,
    mensagem,
    ...(handoff ? { todo: TODO_BY_CODE[motivo] ?? TODO_DEFAULT } : {}),
  };
}

/** The phone of the turn's contact as `+<digits>`, or `null`. Never from the args. */
async function turnPhone(ctx: McpContext): Promise<string | null> {
  if (!ctx.contatoDoTurno) return null;
  const { data, error } = await ctx.supabase
    .from("contacts")
    .select("phone_number")
    .eq("organization_id", ctx.organizationId)
    .eq("id", ctx.contatoDoTurno)
    .maybeSingle<{ phone_number: string | null }>();
  if (error) throw new Error(`avec: contact lookup failed: ${error.message}`);
  const digits = data?.phone_number?.replace(/\D/g, "") ?? "";
  return digits.length >= 10 ? `+${digits}` : null;
}

/** Org gate + trusted phone. Returns the refusal to hand the model when either is missing. */
async function prepare(ctx: McpContext): Promise<{ config: AvecConfig; phone: string } | Refusal> {
  const config = avecConfigFor(ctx.organizationId);
  if (!config) {
    return refusal(
      "avec_indisponivel",
      false,
      "esta ferramenta não está disponível nesta empresa.",
    );
  }
  if (!ctx.contatoDoTurno) {
    return refusal(
      "sem_contato_do_turno",
      false,
      "esta ferramenta só funciona dentro de uma conversa com a cliente.",
    );
  }
  const phone = await turnPhone(ctx);
  if (!phone) {
    return refusal(
      "contato_sem_telefone",
      true,
      "não sei o telefone desta cliente, então não consigo consultar a agenda. " +
        HANDOFF_INSTRUCTION,
    );
  }
  return { config, phone };
}

/** Errors the agent can act on itself; everything else hands off. */
function failure(err: unknown, options: { slotTakenTwice?: boolean; isWrite?: boolean } = {}) {
  if (!(err instanceof AvecApiError)) {
    logger.warn("avec: unexpected tool failure", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      code: "internal_error",
      handoff: true,
      mensagem: HANDOFF_INSTRUCTION,
      todo: TODO_DEFAULT,
    };
  }
  logger.warn("avec: API refused", { status: err.status, code: err.code });
  if (err.code === "not_found") {
    return {
      ok: false,
      code: err.code,
      handoff: false,
      mensagem:
        "não há esse agendamento para o telefone desta cliente. Busque de novo com " +
        "avec_my_appointments e use o appointment_id que vier lá.",
    };
  }
  if (err.code === "slot_unavailable" && !options.slotTakenTwice) {
    return {
      ok: false,
      code: err.code,
      handoff: false,
      mensagem:
        "alguém acabou de pegar esse horário. Busque horários de novo com avec_free_slots e " +
        "ofereça outro à cliente.",
    };
  }
  if (err.code === "already_booked") {
    return {
      ok: false,
      code: err.code,
      handoff: false,
      mensagem:
        "a cliente já tem esse serviço com essa profissional nesse dia. Mostre o horário que ela " +
        "já tem (avec_my_appointments) e ofereça remarcar esse em vez de marcar outro.",
    };
  }
  if (err.code === "idempotency_in_flight") {
    return {
      ok: false,
      code: err.code,
      handoff: false,
      mensagem: "essa mesma alteração ainda está em andamento; espere um instante e chame de novo.",
    };
  }
  // No HTTP answer to a write is the same as `avec_write_unconfirmed`: avec may have written it.
  const unconfirmed =
    err.code === "avec_write_unconfirmed" || (err.status === 0 && options.isWrite);
  return {
    ok: false,
    code: err.code,
    handoff: true,
    mensagem: unconfirmed
      ? "o avec pode ter gravado essa alteração, mas a resposta se perdeu. " + HANDOFF_INSTRUCTION
      : HANDOFF_INSTRUCTION,
    todo: unconfirmed
      ? TODO_BY_CODE.avec_write_unconfirmed
      : (TODO_BY_CODE[err.code] ?? TODO_DEFAULT),
  };
}

/**
 * The `Idempotency-Key` of a write: stable per intended write, so a retry of the same turn
 * replays the first answer instead of writing twice. The body hash is in the key because the
 * API refuses one key with two bodies (`idempotency_key_reused`), and in one turn the agent
 * may try a second slot after the first was taken.
 */
export function avecIdempotencyKey(ctx: McpContext, tool: string, body: unknown): string | null {
  const job = ctx.sourceJobId ?? ctx.idempotencyKey;
  if (!job) return null;
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  return `avec:${job}:${tool}:${hash}`.slice(0, 128);
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

export function resetAvecSlotTakenForTests(): void {
  slotTaken.clear();
}

async function write<T>(
  ctx: McpContext,
  run: () => Promise<T>,
): Promise<T | ReturnType<typeof failure>> {
  try {
    return await run();
  } catch (err) {
    const twice =
      err instanceof AvecApiError && err.code === "slot_unavailable" && slotTakenBefore(ctx);
    return failure(err, { slotTakenTwice: twice, isWrite: true });
  }
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

/**
 * The weekday of a `YYYY-MM-DD` date, in Portuguese. Computed here so the agent never has to:
 * models get weekdays wrong, and Maya's instructions forbid her to calculate dates.
 */
export function weekdayOf(date: string): string | null {
  const day = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(day.getTime()) ? null : WEEKDAYS[day.getUTCDay()]!;
}

/** The avec API only cancels or reschedules Agendado (1) and Confirmado (1.5). */
const CHANGEABLE_STATUS = new Set(["1", "1.5"]);

function appointmentView(a: AvecAppointment) {
  return {
    appointment_id: a.id,
    service_id: a.service_id,
    service: a.service,
    professional_id: a.professional_id,
    professional: a.professional,
    weekday: weekdayOf(a.date),
    date: a.date,
    start_time: a.start_time,
    end_time: a.end_time,
    status: a.status_name ?? a.status,
    can_change: a.status !== null && CHANGEABLE_STATUS.has(a.status),
  };
}

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "use AAAA-MM-DD")
  .optional()
  .describe("Data no formato AAAA-MM-DD (fuso de Brasília).");

const freeText = (what: string) => z.string().trim().max(300).optional().describe(what);

// The free text a client wrote never goes to `api_audit_log`.
function redactFreeText(field: string) {
  return (args: Record<string, unknown>) =>
    typeof args[field] === "string" ? { ...args, [field]: "[redacted]" } : args;
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

const myAppointmentsShape = {
  from: date,
  to: date,
};

export const avecMyAppointments: McpToolDefinition<typeof myAppointmentsShape> = {
  name: "avec_my_appointments",
  description:
    "Lista os agendamentos da cliente DESTA conversa na agenda do salão (avec), pelo telefone " +
    "dela — você não informa telefone. Sem datas, traz de hoje até 13 dias à frente (no máximo " +
    "14 dias por consulta). Use sempre antes de remarcar ou cancelar, para pegar o " +
    "appointment_id. Se vier mais de um, pergunte qual antes de agir. Só os de can_change: true " +
    "podem ser remarcados ou cancelados; os outros, passe para a equipe.",
  inputSchema: myAppointmentsShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const ready = await prepare(ctx);
    if ("ok" in ready) return ready;
    try {
      // Field by field, never a spread: nothing in the args may reach the API as the phone.
      const items = await listAppointments(ready.config, {
        phone: ready.phone,
        from: input.from,
        to: input.to,
      });
      return { ok: true, agendamentos: items.map(appointmentView), total: items.length };
    } catch (err) {
      return failure(err);
    }
  },
};

const professionalsCache = new Map<string, { at: number; data: AvecProfessional[] }>();

async function professionals(config: AvecConfig): Promise<AvecProfessional[]> {
  const hit = professionalsCache.get(config.baseUrl);
  if (hit && Date.now() - hit.at < PROFESSIONALS_TTL_MS) return hit.data;
  const data = await listProfessionals(config);
  professionalsCache.set(config.baseUrl, { at: Date.now(), data });
  return data;
}

export function resetAvecProfessionalsCacheForTests(): void {
  professionalsCache.clear();
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const findServicesShape = {
  search: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .describe(
      'O serviço que a cliente pediu, como ela disse (ex.: "corte", "escova", "sobrancelha").',
    ),
};

export const avecFindServices: McpToolDefinition<typeof findServicesShape> = {
  name: "avec_find_services",
  description:
    "Procura um serviço do salão no avec pelo nome e diz quais profissionais o fazem, com " +
    `service_id, professional_id e duração. Devolve no máximo ${MAX_SERVICES} linhas. Use antes ` +
    "de avec_free_slots. Se vier mais de um serviço parecido, pergunte à cliente qual é. Não " +
    "informe preço por aqui: siga o material do salão.",
  inputSchema: findServicesShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  motivoDoVazio: (result) =>
    (result as { ok?: boolean; total_encontrado?: number })?.ok === true &&
    (result as { total_encontrado: number }).total_encontrado === 0
      ? "servico_nao_encontrado"
      : null,
  handler: async (input, ctx) => {
    const ready = await prepare(ctx);
    if ("ok" in ready) return ready;
    try {
      const terms = fold(input.search).split(" ");
      const matches = (await professionals(ready.config))
        .flatMap((p) =>
          p.services.map((s) => ({
            service_id: s.id,
            service: s.name,
            professional_id: p.id,
            professional: p.name,
            duration_minutes: s.duration_minutes,
          })),
        )
        .filter((row) => {
          const name = fold(row.service ?? "");
          return terms.every((t) => name.includes(t));
        })
        .sort(
          (a, b) =>
            (a.service ?? "").localeCompare(b.service ?? "", "pt-BR") ||
            (a.professional ?? "").localeCompare(b.professional ?? "", "pt-BR"),
        );
      return {
        ok: true,
        servicos: matches.slice(0, MAX_SERVICES),
        total_encontrado: matches.length,
        ...(matches.length > MAX_SERVICES
          ? { aviso: "há mais resultados: pergunte à cliente o serviço exato ou a profissional." }
          : {}),
      };
    } catch (err) {
      return failure(err);
    }
  },
};

const freeSlotsShape = {
  service_id: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .describe("O service_id que veio de avec_find_services."),
  professional_id: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .optional()
    .describe(
      "Só esta profissional (professional_id de avec_find_services). Sem ele, todas que fazem o serviço.",
    ),
  from: date,
  to: date,
};

export const avecFreeSlots: McpToolDefinition<typeof freeSlotsShape> = {
  name: "avec_free_slots",
  description:
    "Mostra os horários livres de um serviço no avec, os mais cedo primeiro, no máximo " +
    `${MAX_SLOTS}. Sem datas, olha os próximos 7 dias. Cada horário tem um slot_id: use só ` +
    "slot_id que veio daqui, nunca monte um. Ofereça poucas opções à cliente e confirme a " +
    "escolhida antes de marcar ou remarcar.",
  inputSchema: freeSlotsShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const ready = await prepare(ctx);
    if ("ok" in ready) return ready;
    try {
      const slots = (
        await listAvailability(ready.config, {
          service_id: input.service_id,
          professional_id: input.professional_id,
          from: input.from,
          to: input.to,
        })
      ).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
      return {
        ok: true,
        horarios: slots.slice(0, MAX_SLOTS).map((s) => ({
          slot_id: s.id,
          professional_id: s.professional_id,
          weekday: weekdayOf(s.date),
          date: s.date,
          start_time: s.start_time,
          end_time: s.end_time,
        })),
        total_encontrado: slots.length,
      };
    } catch (err) {
      return failure(err);
    }
  },
};

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

const NO_JOB = refusal(
  "sem_chave_de_idempotencia",
  true,
  "não consigo garantir que esta alteração não seja gravada duas vezes. " + HANDOFF_INSTRUCTION,
);

const cancelShape = {
  appointment_id: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe("O appointment_id que veio de avec_my_appointments."),
  reason: freeText(
    "O motivo em poucas palavras, se a cliente disse (vai para a observação do agendamento).",
  ),
};

export const avecCancel: McpToolDefinition<typeof cancelShape> = {
  name: "avec_cancel",
  description:
    "Cancela um agendamento da cliente DESTA conversa no avec. Antes: ofereça remarcar; só " +
    "cancele se ela preferir cancelar, e confirme com ela o serviço, o dia e o horário que vão " +
    "ser cancelados. Use o appointment_id de avec_my_appointments. Se ela tiver mais de um " +
    "agendamento, pergunte qual.",
  inputSchema: cancelShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  redigirParaAuditoria: redactFreeText("reason"),
  handler: async (input, ctx) => {
    const ready = await prepare(ctx);
    if ("ok" in ready) return ready;
    const key = avecIdempotencyKey(ctx, "avec_cancel", input);
    if (!key) return NO_JOB;
    return write(ctx, async () => {
      const result = await cancelAppointment(ready.config, {
        appointmentId: input.appointment_id,
        phone: ready.phone,
        reason: input.reason,
        idempotencyKey: key,
      });
      return { ok: true, appointment_id: result.id, status: result.status };
    });
  },
};

const rescheduleShape = {
  appointment_id: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe("O appointment_id que veio de avec_my_appointments."),
  slot_id: z.string().trim().min(1).max(80).describe("O slot_id que veio de avec_free_slots."),
};

export const avecReschedule: McpToolDefinition<typeof rescheduleShape> = {
  name: "avec_reschedule",
  description:
    "Remarca um agendamento da cliente DESTA conversa no avec para outro horário, com a mesma " +
    "profissional e o mesmo serviço. Antes: confirme com ela o novo dia e horário. Use o " +
    "appointment_id de avec_my_appointments e um slot_id de avec_free_slots da MESMA " +
    "profissional e do MESMO serviço. Depois de remarcar, o appointment_id muda: use o novo.",
  inputSchema: rescheduleShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const ready = await prepare(ctx);
    if ("ok" in ready) return ready;
    const key = avecIdempotencyKey(ctx, "avec_reschedule", input);
    if (!key) return NO_JOB;
    return write(ctx, async () => {
      const moved = await rescheduleAppointment(ready.config, {
        appointmentId: input.appointment_id,
        phone: ready.phone,
        slotId: input.slot_id,
        idempotencyKey: key,
      });
      return {
        ok: true,
        agendamento: appointmentView(moved),
        aviso: "o appointment_id pode ter mudado: use o deste resultado daqui em diante.",
      };
    });
  },
};

const bookShape = {
  slot_id: z.string().trim().min(1).max(80).describe("O slot_id que veio de avec_free_slots."),
  note: freeText(
    "Observação curta para o salão, se a cliente pediu algo (vai para o agendamento).",
  ),
};

export const avecBook: McpToolDefinition<typeof bookShape> = {
  name: "avec_book",
  description:
    "Marca um horário novo no avec para a cliente DESTA conversa, pelo telefone dela. Antes: " +
    "confirme com ela o serviço, a profissional, o dia e o horário. Use só um slot_id de " +
    "avec_free_slots. Se o avec não conhecer a cliente, a resposta pede para passar para a " +
    "equipe cadastrá-la.",
  inputSchema: bookShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  redigirParaAuditoria: redactFreeText("note"),
  handler: async (input, ctx) => {
    const ready = await prepare(ctx);
    if ("ok" in ready) return ready;
    const key = avecIdempotencyKey(ctx, "avec_book", input);
    if (!key) return NO_JOB;
    return write(ctx, async () => {
      const booked = await createAppointment(ready.config, {
        phone: ready.phone,
        slotId: input.slot_id,
        note: input.note,
        idempotencyKey: key,
      });
      return { ok: true, agendamento: appointmentView(booked) };
    });
  },
};
