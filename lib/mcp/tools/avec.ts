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
  getAppointment,
  listAppointments,
  listAvailability,
  rescheduleAppointment,
  type AvecAppointment,
} from "@/lib/integrations/avec/client";
import { avecConfigFor, type AvecConfig } from "@/lib/integrations/avec/config";
import {
  COMPRIMENTOS,
  MAX_OPCOES,
  OPCAO_REMARCAR,
  consultasPara,
  escolherOpcoes,
  etapasDe,
  montarOpcoes,
  ofertaPorId,
  parseSlotId,
  salaoDa,
  servicosAvulsos,
  validarOpcao,
  type Opcao,
  type Salao,
} from "@/lib/integrations/avec/ofertas";
import { logger } from "@/lib/logger";

import type { McpContext, McpToolDefinition } from "../types";

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

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const SEM_OFERTAS = refusal(
  "sem_ofertas",
  true,
  "este salão não tem serviços liberados para a Maya marcar sozinha. " + HANDOFF_INSTRUCTION,
);

/** Today in Brasília, `YYYY-MM-DD`. */
export function hojeEmBrasilia(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** `27/10`: the agent repeats this, never computes it. */
const dataBr = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

const nomeDe = (salao: Salao, id: string | undefined) =>
  id ? (salao.profissionais[id]?.nome ?? null) : null;

const findServicesShape = {
  search: z
    .string()
    .trim()
    .max(80)
    .optional()
    .describe("Opcional: o serviço como a cliente disse. A lista volta inteira de qualquer forma."),
};

export const avecFindServices: McpToolDefinition<typeof findServicesShape> = {
  name: "avec_find_services",
  description:
    "Lista os serviços que você pode marcar sozinha na agenda do salão (avec), com o código " +
    "(servico) para usar em avec_free_slots, quem faz e o que perguntar antes (comprimento do " +
    "cabelo, preferência de profissional). Também lista o que é sempre da equipe: para esses, " +
    "não busque horário, passe para a equipe. Se o pedido da cliente não for exatamente um dos " +
    "serviços da lista, passe para a equipe.",
  inputSchema: findServicesShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (_input, ctx) => {
    const ready = await prepare(ctx);
    if ("ok" in ready) return ready;
    const salao = salaoDa(ctx.organizationId);
    if (!salao) return SEM_OFERTAS;
    return {
      ok: true,
      servicos: salao.ofertas.map((o) => ({
        servico: o.id,
        nome: o.rotulo,
        profissionais: o.porProfissional.map((p) => nomeDe(salao, p.profissional)),
        precisa_comprimento: o.comprimento,
        ...(o.perguntar ? { perguntar_antes: o.perguntar } : {}),
      })),
      comprimentos: COMPRIMENTOS,
      com_a_equipe: salao.comAEquipe,
    };
  },
};

/** The professionals of an oferta the client accepts: all, or the one she named. */
function principaisPara(
  salao: Salao,
  oferta: NonNullable<ReturnType<typeof ofertaPorId>>,
  profissional: string | undefined,
): string[] | null {
  const todas = oferta.porProfissional.map((p) => p.profissional);
  if (!profissional) return todas;
  const alvo = fold(profissional);
  const achadas = todas.filter((id) => {
    const nome = fold(salao.profissionais[id]?.nome ?? "");
    return id === profissional.trim() || nome === alvo || nome.split(" ")[0] === alvo;
  });
  return achadas.length ? achadas : null;
}

function opcaoView(salao: Salao, o: Opcao) {
  return {
    opcao_id: o.opcao_id,
    dia_semana: weekdayOf(o.data),
    data: o.data,
    data_br: dataBr(o.data),
    inicio: o.inicio,
    termina_por_volta_de: o.fim,
    profissional: nomeDe(salao, o.profissional),
    ...(o.auxiliar ? { lavagem_ou_secagem_com: nomeDe(salao, o.auxiliar) } : {}),
    agrupado: o.agrupamento === 0,
  };
}

const DIAS = ["terca", "quarta", "quinta", "sexta", "sabado"] as const;

const freeSlotsShape = {
  servico: z
    .string()
    .trim()
    .max(40)
    .optional()
    .describe("O código do serviço (campo servico de avec_find_services). Não use ao remarcar."),
  comprimento: z
    .enum(["curto", "medio", "longo", "extra_longo"])
    .optional()
    .describe("Comprimento do cabelo que a cliente disse, quando o serviço precisa."),
  profissional: z
    .string()
    .trim()
    .max(60)
    .optional()
    .describe("Nome da profissional, só se a cliente pediu uma. Sem preferência: deixe vazio."),
  data: date.describe("Um dia exato que a cliente pediu (AAAA-MM-DD)."),
  dias_semana: z
    .array(z.enum(DIAS))
    .max(5)
    .optional()
    .describe('Dias da semana que a cliente pediu (ex.: "sexta" → ["sexta"]).'),
  periodo: z.enum(["manha", "tarde"]).optional().describe("Manhã (antes das 12h) ou tarde."),
  horario: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "use HH:MM")
    .optional()
    .describe("Horário que a cliente pediu (HH:MM): os mais próximos vêm primeiro."),
  remarcar_appointment_id: z
    .string()
    .trim()
    .max(80)
    .optional()
    .describe(
      "Para remarcar: o appointment_id de avec_my_appointments. Traz horários da mesma profissional e do mesmo serviço.",
    ),
};

/**
 * A visit the agent may change alone: one service that day, of a one-step oferta, still
 * Agendado/Confirmado. A visit of several bookings (corte with lavagem and secagem) moves as a
 * whole, so it stays with the team for now.
 */
async function visitaAvulsa(
  ctx: McpContext,
  config: AvecConfig,
  phone: string,
  salao: Salao,
  appointmentId: string,
): Promise<{ appointment: AvecAppointment } | Refusal> {
  const appointment = await getAppointment(config, { id: appointmentId, phone });
  const sameDay = await listAppointments(config, {
    phone,
    from: appointment.date,
    to: appointment.date,
  });
  const motivo =
    appointment.status === null || !CHANGEABLE_STATUS.has(appointment.status)
      ? "not_allowed"
      : sameDay.length > 1
        ? "visita_com_varios_servicos"
        : !servicosAvulsos(salao).has(appointment.service_id)
          ? "servico_com_a_equipe"
          : null;
  if (!motivo) return { appointment };
  logger.info("avec: change kept for the team", { motivo, org: ctx.organizationId });
  return {
    ...refusal(motivo, true, HANDOFF_INSTRUCTION),
    todo:
      motivo === "visita_com_varios_servicos"
        ? `A cliente tem ${sameDay.length} serviços no avec em ${dataBr(appointment.date)}: remarcar ou cancelar a visita inteira com ela.`
        : motivo === "not_allowed"
          ? TODO_BY_CODE.not_allowed!
          : `Remarcar ou cancelar ${appointment.service ?? "o serviço"} de ${dataBr(appointment.date)} às ${appointment.start_time} no avec.`,
  };
}

export const avecFreeSlots: McpToolDefinition<typeof freeSlotsShape> = {
  name: "avec_free_slots",
  description:
    `Busca até ${MAX_OPCOES} opções de horário na agenda do salão (avec), já escolhidas pela ` +
    "regra do salão: primeiro o que a cliente pediu, depois horários colados em clientes que a " +
    "profissional já tem no dia. Cada opção traz dia da semana, data, hora, profissional e um " +
    'opcao_id. Ofereça à cliente com dia, data, hora e profissional (ex.: "sexta, 30/10, às ' +
    '15h com a Giovanna"). Use só opcao_id que veio daqui. Para marcar: servico (+ comprimento ' +
    "quando precisa). Para remarcar: remarcar_appointment_id. Sem preferência de dia, olha as " +
    "próximas 2 semanas.",
  inputSchema: freeSlotsShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  motivoDoVazio: (result) =>
    (result as { ok?: boolean; opcoes?: unknown[] })?.ok === true &&
    (result as { opcoes: unknown[] }).opcoes.length === 0
      ? "sem_horario"
      : null,
  handler: async (input, ctx) => {
    const ready = await prepare(ctx);
    if ("ok" in ready) return ready;
    const salao = salaoDa(ctx.organizationId);
    if (!salao) return SEM_OFERTAS;
    const hoje = hojeEmBrasilia();
    const from = input.data ?? hoje;
    const to = input.data ?? addDays(hoje, 13);
    if (input.data && input.data < hoje) {
      return { ok: false, handoff: false, mensagem: "essa data já passou: confira com a cliente." };
    }
    const pref = {
      data: input.data,
      dias_semana: input.dias_semana,
      periodo: input.periodo,
      horario: input.horario,
    };
    try {
      let opcoes: Opcao[];
      if (input.remarcar_appointment_id) {
        const avulsa = await visitaAvulsa(
          ctx,
          ready.config,
          ready.phone,
          salao,
          input.remarcar_appointment_id,
        );
        if ("ok" in avulsa) return avulsa;
        const a = avulsa.appointment;
        const slots = await listAvailability(ready.config, {
          service_id: a.service_id,
          professional_id: a.professional_id,
          from,
          to,
        });
        opcoes = slots.map((s) => ({
          opcao_id: `${OPCAO_REMARCAR}:-:${s.id}`,
          data: s.date,
          inicio: s.start_time,
          fim: s.end_time,
          profissional: s.professional_id,
          agrupamento:
            (s.gap_before_minutes ?? 99) <= 30 || (s.gap_after_minutes ?? 99) <= 30
              ? 0
              : (s.bookings_that_day ?? 0) > 0
                ? 1
                : 2,
        }));
      } else {
        const oferta = input.servico ? ofertaPorId(salao, input.servico) : null;
        if (!oferta) {
          return {
            ok: false,
            handoff: false,
            mensagem:
              "serviço desconhecido: use o campo servico de avec_find_services. Se o pedido " +
              "não está na lista, passe para a equipe.",
          };
        }
        const comprimento = oferta.comprimento ? (input.comprimento ?? null) : null;
        if (oferta.comprimento && !comprimento) {
          return {
            ok: false,
            handoff: false,
            mensagem:
              "este serviço depende do comprimento do cabelo: pergunte à cliente se é curto, " +
              "médio, longo ou extra longo e chame de novo com comprimento.",
          };
        }
        const principais = principaisPara(salao, oferta, input.profissional);
        if (!principais) {
          return {
            ok: false,
            handoff: false,
            mensagem: `essa profissional não faz este serviço aqui. Quem faz: ${oferta.porProfissional
              .map((p) => nomeDe(salao, p.profissional))
              .join(", ")}. Pergunte à cliente.`,
          };
        }
        if (principais.every((p) => etapasDe(oferta, p, comprimento) === null)) {
          return {
            ...refusal("comprimento_com_a_equipe", true, HANDOFF_INSTRUCTION),
            todo: `Marcar ${oferta.rotulo} (cabelo ${comprimento}) no avec.`,
          };
        }
        const consultas = consultasPara(salao, oferta, principais, comprimento);
        const slots = (
          await Promise.all(
            consultas.map((c) =>
              listAvailability(ready.config, {
                service_id: c.servico,
                professional_id: c.profissional,
                from,
                to,
              }),
            ),
          )
        ).flat();
        opcoes = montarOpcoes(salao, oferta, principais, comprimento, slots);
      }
      const escolhidas = escolherOpcoes(opcoes, pref, hoje);
      return {
        ok: true,
        opcoes: escolhidas.map((o) => opcaoView(salao, o)),
        ...(escolhidas.length === 0
          ? {
              mensagem:
                opcoes.length > 0
                  ? "não há horário agrupado nesse período. Pergunte à cliente outro dia ou " +
                    "período; se ela só puder nesse, passe para a equipe."
                  : "não há horário livre nesse período. Pergunte à cliente outro dia ou " +
                    "período; se não houver, passe para a equipe.",
            }
          : {}),
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
    "agendamento, pergunte qual. Visita com vários serviços no dia vai para a equipe.",
  inputSchema: cancelShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  redigirParaAuditoria: redactFreeText("reason"),
  handler: async (input, ctx) => {
    const ready = await prepare(ctx);
    if ("ok" in ready) return ready;
    const salao = salaoDa(ctx.organizationId);
    if (!salao) return SEM_OFERTAS;
    const key = avecIdempotencyKey(ctx, "avec_cancel", input);
    if (!key) return NO_JOB;
    try {
      const avulsa = await visitaAvulsa(
        ctx,
        ready.config,
        ready.phone,
        salao,
        input.appointment_id,
      );
      if ("ok" in avulsa) return avulsa;
    } catch (err) {
      return failure(err);
    }
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
  opcao_id: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe("O opcao_id que veio de avec_free_slots com remarcar_appointment_id."),
};

export const avecReschedule: McpToolDefinition<typeof rescheduleShape> = {
  name: "avec_reschedule",
  description:
    "Remarca um agendamento da cliente DESTA conversa no avec para outro horário, com a mesma " +
    "profissional e o mesmo serviço. Antes: busque opções com avec_free_slots " +
    "(remarcar_appointment_id) e confirme com ela o novo dia, hora e profissional. Depois de " +
    "remarcar, o appointment_id muda: use o novo.",
  inputSchema: rescheduleShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const ready = await prepare(ctx);
    if ("ok" in ready) return ready;
    const salao = salaoDa(ctx.organizationId);
    if (!salao) return SEM_OFERTAS;
    const [kind, , slotId, ...rest] = input.opcao_id.split(":");
    const slot = slotId ? parseSlotId(slotId) : null;
    if (kind !== OPCAO_REMARCAR || !slot || rest.length) {
      return {
        ok: false,
        handoff: false,
        mensagem:
          "opcao_id inválido: busque com avec_free_slots usando remarcar_appointment_id e use o opcao_id que vier.",
      };
    }
    const key = avecIdempotencyKey(ctx, "avec_reschedule", input);
    if (!key) return NO_JOB;
    try {
      const avulsa = await visitaAvulsa(
        ctx,
        ready.config,
        ready.phone,
        salao,
        input.appointment_id,
      );
      if ("ok" in avulsa) return avulsa;
      const a = avulsa.appointment;
      if (a.service_id !== slot.servico || a.professional_id !== slot.profissional) {
        return {
          ok: false,
          handoff: false,
          mensagem:
            "esse horário é de outro serviço ou profissional: busque de novo com remarcar_appointment_id.",
        };
      }
    } catch (err) {
      return failure(err);
    }
    return write(ctx, async () => {
      const moved = await rescheduleAppointment(ready.config, {
        appointmentId: input.appointment_id,
        phone: ready.phone,
        slotId: slotId!,
        idempotencyKey: key,
      });
      return {
        ok: true,
        agendamento: { ...appointmentView(moved), data_br: dataBr(moved.date) },
        aviso: "o appointment_id pode ter mudado: use o deste resultado daqui em diante.",
      };
    });
  },
};

const bookShape = {
  opcao_id: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .describe("O opcao_id que veio de avec_free_slots (com servico), exatamente como veio."),
  note: freeText(
    "Observação curta para o salão, se a cliente pediu algo (vai para o agendamento).",
  ),
};

export const avecBook: McpToolDefinition<typeof bookShape> = {
  name: "avec_book",
  description:
    "Marca no avec a visita de uma opção de avec_free_slots para a cliente DESTA conversa, pelo " +
    "telefone dela, com todas as etapas (ex.: corte, lavagem e secagem). Antes: confirme com " +
    "ela o serviço, o dia, a hora e a profissional, e espere o sim. Se o avec não conhecer a " +
    "cliente, a resposta pede para passar para a equipe cadastrá-la.",
  inputSchema: bookShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  redigirParaAuditoria: redactFreeText("note"),
  handler: async (input, ctx) => {
    const ready = await prepare(ctx);
    if ("ok" in ready) return ready;
    const salao = salaoDa(ctx.organizationId);
    if (!salao) return SEM_OFERTAS;
    const opcao = validarOpcao(salao, input.opcao_id);
    if (!opcao) {
      return {
        ok: false,
        handoff: false,
        mensagem:
          "opcao_id inválido: use exatamente um opcao_id que veio de avec_free_slots, sem mudar nada.",
      };
    }
    if (!avecIdempotencyKey(ctx, "avec_book", input)) return NO_JOB;
    const feitos: AvecAppointment[] = [];
    for (const [i, slot] of opcao.slots.entries()) {
      const key = avecIdempotencyKey(ctx, "avec_book", { opcao_id: input.opcao_id, etapa: i })!;
      try {
        feitos.push(
          await createAppointment(ready.config, {
            phone: ready.phone,
            slotId: slot.slotId,
            note: i === 0 ? input.note : undefined,
            idempotencyKey: key,
          }),
        );
      } catch (err) {
        if (i === 0) {
          const twice =
            err instanceof AvecApiError && err.code === "slot_unavailable" && slotTakenBefore(ctx);
          return failure(err, { slotTakenTwice: twice, isWrite: true });
        }
        logger.warn("avec: visit booked in part", {
          step: i,
          code: err instanceof AvecApiError ? err.code : "unexpected",
        });
        const hhmm = `${String(Math.floor(slot.inicio / 60)).padStart(2, "0")}:${String(slot.inicio % 60).padStart(2, "0")}`;
        return {
          ok: false,
          code: err instanceof AvecApiError ? err.code : "internal_error",
          handoff: true,
          parcial: true,
          mensagem:
            "a visita ficou marcada só em parte. Não confirme o horário à cliente: diga que a " +
            "Ruth da recepção finaliza o agendamento e já responde por aqui. " +
            HANDOFF_INSTRUCTION,
          todo:
            `Ficou marcado no avec: ${feitos.map((f) => `${f.service ?? "serviço"} ${dataBr(f.date)} ${f.start_time} (${f.professional ?? ""})`).join("; ")}. ` +
            `Falta marcar a etapa ${i + 1} de ${opcao.oferta.rotulo} às ${hhmm} (${nomeDe(salao, slot.profissional) ?? "auxiliar"}): conferir e completar no avec, depois confirmar com a cliente.`,
        };
      }
    }
    const first = feitos[0]!;
    return {
      ok: true,
      agendamento: {
        servico: opcao.oferta.rotulo,
        dia_semana: weekdayOf(first.date),
        data: first.date,
        data_br: dataBr(first.date),
        inicio: first.start_time,
        termina_por_volta_de: feitos
          .map((f) => f.end_time)
          .sort()
          .at(-1),
        profissional: nomeDe(salao, opcao.principal) ?? first.professional,
        status: first.status_name ?? first.status,
      },
      etapas: feitos.map(appointmentView),
    };
  },
};
