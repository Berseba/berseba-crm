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
  confirmAppointment,
  createAppointment,
  getAppointment,
  listAppointments,
  listAvailability,
  rescheduleAppointment,
  type AvecAppointment,
} from "@/lib/integrations/avec/client";
import type { ConfigDaListaDeEspera } from "@/lib/agenda/lista-de-espera";
import { conferirPedido, fold, opcoesDoPedido, principaisPara } from "@/lib/integrations/avec/busca";
import { avecConfigFor, type AvecConfig } from "@/lib/integrations/avec/config";
import {
  MAX_DIAS_A_FRENTE,
  janelaDeBusca,
  motivoParaNaoServir,
  ocupacaoDa,
  sobrepoe,
  type InscricaoAvec,
} from "@/lib/integrations/avec/lista-de-espera";
import type { OfertaGuardada } from "@/lib/integrations/avec/lista-de-espera-motor";
import {
  configDaEsperaAvec,
  dispararBuscaDaEspera,
  encerrarAoMarcar,
  lerOferta,
  ocupacoesSeguradasPorOutras,
  repoSupabase,
} from "@/lib/integrations/avec/lista-de-espera-supabase";
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
  type Comprimento,
  type Opcao,
  type Salao,
} from "@/lib/integrations/avec/ofertas";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import type { McpContext, McpToolDefinition } from "../types";

const SLOT_TAKEN_TTL_MS = 30 * 60_000;

// The client never hears the receptionist's name (Matheus, 2026-10-23): "nossa equipe de atendimento".
const HANDOFF_INSTRUCTION =
  "Não tente de novo. Diga à cliente, sem falar de erro nem de sistema, que a nossa equipe de " +
  "atendimento vai finalizar e já responde por aqui (nunca diga o nome de quem atende). Depois " +
  "chame crm_request_human_handoff com um resumo: o pedido (serviço, dia, hora, profissional) e o " +
  "que a equipe precisa fazer no avec (o campo todo).";

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
async function turnContact(
  ctx: McpContext,
): Promise<{ phone: string | null; name: string | null }> {
  if (!ctx.contatoDoTurno) return { phone: null, name: null };
  const { data, error } = await ctx.supabase
    .from("contacts")
    .select("phone_number, name")
    .eq("organization_id", ctx.organizationId)
    .eq("id", ctx.contatoDoTurno)
    .maybeSingle<{ phone_number: string | null; name: string | null }>();
  if (error) throw new Error(`avec: contact lookup failed: ${error.message}`);
  const digits = data?.phone_number?.replace(/\D/g, "") ?? "";
  return {
    phone: digits.length >= 10 ? `+${digits}` : null,
    // Only breaks a tie when two avec records share the phone (Berseba/berseba-mayara-morales#28).
    name: data?.name?.trim() || null,
  };
}

/** Org gate + trusted phone. Returns the refusal to hand the model when either is missing. */
async function prepare(
  ctx: McpContext,
): Promise<{ config: AvecConfig; phone: string; name: string | null } | Refusal> {
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
  const { phone, name } = await turnContact(ctx);
  if (!phone) {
    return refusal(
      "contato_sem_telefone",
      true,
      "não sei o telefone desta cliente, então não consigo consultar a agenda. " +
        HANDOFF_INSTRUCTION,
    );
  }
  return { config, phone, name };
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

function opcaoView(salao: Salao, o: Opcao) {
  return {
    opcao_id: o.opcao_id,
    dia_semana: weekdayOf(o.data),
    data: o.data,
    data_br: dataBr(o.data),
    inicio: o.inicio,
    termina_por_volta_de: o.fim,
    profissional: nomeDe(salao, o.profissional),
    ...(o.auxiliar && o.etapasDaAuxiliar
      ? {
          // "lavagem às 14:00 e secagem às 14:30 com a Júlia": the client chooses her too.
          tambem: o.etapasDaAuxiliar.map((e) => `${e.servico} às ${e.inicio}`).join(" e "),
          tambem_com: nomeDe(salao, o.auxiliar),
        }
      : {}),
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
  auxiliar: z
    .string()
    .trim()
    .max(60)
    .optional()
    .describe(
      "Quem faz a lavagem/secagem, só se a cliente pediu uma pessoa (ou recusou a que veio e escolheu outra).",
    ),
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
  depois_de: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "use HH:MM")
    .optional()
    .describe('"depois das 17h" = "17:00"'),
  ate: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "use HH:MM")
    .optional()
    .describe('"até as 10h" = "10:00"'),
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

/** The waitlist is on for this organization. A failure reads as off: the old rule applies. */
async function listaLigada(ctx: McpContext): Promise<boolean> {
  try {
    return (await configDaEsperaAvec(createAdminClient(), ctx.organizationId)) !== null;
  } catch {
    return false;
  }
}

/** The waitlist's holds for other clients. A failure never blocks the search: it shows all. */
async function seguradasPorOutras(ctx: McpContext) {
  try {
    return await ocupacoesSeguradasPorOutras(
      createAdminClient(),
      ctx.organizationId,
      ctx.contatoDoTurno ?? null,
      new Date(),
    );
  } catch (err) {
    logger.warn("avec: waitlist holds unreadable", { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export const avecFreeSlots: McpToolDefinition<typeof freeSlotsShape> = {
  name: "avec_free_slots",
  description:
    `Busca até ${MAX_OPCOES} opções de horário na agenda do salão (avec), já escolhidas pela ` +
    "regra do salão: primeiro o que a cliente pediu, depois horários colados em clientes que a " +
    "profissional já tem no dia. Cada opção traz dia da semana, data, hora, profissional, as " +
    "etapas com outra pessoa (tambem, tambem_com: lavagem e secagem) e um opcao_id. " +
    'Ofereça com dia, data e hora (ex.: "sexta, 30/10, às 15h"). Use só opcao_id que ' +
    "veio daqui. Para marcar: servico (+ comprimento " +
    "quando precisa). Para remarcar: remarcar_appointment_id. Sem preferência de dia, olha as " +
    "próximas 2 semanas.",
  inputSchema: freeSlotsShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
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
      depois_de: input.depois_de,
      ate: input.ate,
    };
    try {
      let opcoes: Opcao[];
      let pedido = "o serviço que a cliente pediu";
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
        pedido = `remarcar ${a.service ?? "o serviço"} de ${dataBr(a.date)} às ${a.start_time}`;
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
        if (oferta.semSabado) {
          const sabado = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay() === 6;
          const soSabado =
            (input.data && sabado(input.data)) ||
            (input.dias_semana?.length && input.dias_semana.every((d) => d === "sabado"));
          if (soSabado) {
            return {
              ...refusal(
                "sabado_com_a_equipe",
                true,
                "nunca diga que não há horário no sábado. " + HANDOFF_INSTRUCTION,
              ),
              todo: `A cliente quer ${oferta.rotulo} no sábado: ver com ela.`,
            };
          }
        }
        pedido = `${oferta.rotulo}${input.profissional ? ` com ${input.profissional}` : ""}`;
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
        let auxiliares = salao.auxiliares;
        if (input.auxiliar) {
          const alvo = fold(input.auxiliar);
          auxiliares = salao.auxiliares.filter((id) => {
            const nome = fold(salao.profissionais[id]?.nome ?? "");
            return nome === alvo || nome.split(" ")[0] === alvo;
          });
          if (!auxiliares.length) {
            return {
              ok: false,
              handoff: false,
              mensagem: `quem faz lavagem e secagem aqui: ${salao.auxiliares
                .map((id) => nomeDe(salao, id))
                .join(", ")}. Pergunte à cliente.`,
            };
          }
        }
        const consultas = consultasPara(salao, oferta, principais, comprimento, auxiliares);
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
        opcoes = montarOpcoes(salao, oferta, principais, comprimento, slots, auxiliares).filter(
          (o) => !oferta.semSabado || new Date(`${o.data}T12:00:00Z`).getUTCDay() !== 6,
        );
      }
      // A slot the waitlist offered to another client is hers until the deadline.
      const seguradas = await seguradasPorOutras(ctx);
      if (seguradas.length) opcoes = opcoes.filter((o) => !sobrepoe(ocupacaoDa(o), seguradas));
      const escolhidas = escolherOpcoes(opcoes, pref, hoje);
      if (escolhidas.length === 0) {
        // No slot the salon would offer: a person finds a fit (Matheus, 2026-10-23).
        const quando = [
          input.data ? dataBr(input.data) : null,
          input.dias_semana?.join(", "),
          input.periodo === "manha" ? "manhã" : input.periodo,
          input.horario,
          input.depois_de ? `depois das ${input.depois_de}` : null,
          input.ate ? `até ${input.ate}` : null,
        ]
          .filter(Boolean)
          .join(", ");
        const todo = `Sem horário na agenda pelo sistema para ${pedido}${quando ? ` (${quando})` : ""}: ver um encaixe com a cliente.`;
        // With the waitlist on, the client is offered the list before the team is called.
        if (!input.remarcar_appointment_id && (await listaLigada(ctx))) {
          return {
            ok: false,
            permitido: false,
            motivo: "sem_horario",
            handoff: false,
            lista_de_espera: true,
            mensagem:
              "não encontrei horário para esse pedido. Não diga só que não há horário: diga com carinho " +
              "que esse horário está ocupado e ofereça colocá-la na lista de espera (avec_waitlist, acao " +
              "entrar), com os dias e a faixa de horário que ela pode. Se ela não quiser a lista, chame " +
              "crm_request_human_handoff com o pedido e o todo, para a equipe ver um encaixe.",
            todo,
          };
        }
        return {
          ...refusal(
            "sem_horario",
            true,
            "não encontrei horário para esse pedido. Não diga que não há horário: diga à " +
              "cliente, com carinho, que a nossa equipe de atendimento vai ver o melhor horário e " +
              "já responde por aqui. Depois chame crm_request_human_handoff com o pedido e o todo.",
          ),
          todo,
        };
      }
      return { ok: true, opcoes: escolhidas.map((o) => opcaoView(salao, o)) };
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
      // The freed slot may be someone's on the waitlist.
      dispararBuscaDaEspera(ctx.organizationId);
      return { ok: true, appointment_id: result.id, status: result.status };
    });
  },
};

const confirmShape = {
  appointment_id: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe("O appointment_id que veio de avec_my_appointments (qualquer um do dia)."),
};

export const avecConfirm: McpToolDefinition<typeof confirmShape> = {
  name: "avec_confirm",
  description:
    "Confirma a presença da cliente DESTA conversa no avec, como o botão Confirmar do avec: " +
    "todos os agendamentos dela naquele dia ficam Confirmado. Use quando ela confirmar que vem " +
    "(ex.: respondeu 'confirmo' à mensagem da véspera), com o appointment_id de " +
    "avec_my_appointments. Não muda dia, hora nem serviço.",
  inputSchema: confirmShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const ready = await prepare(ctx);
    if ("ok" in ready) return ready;
    const key = avecIdempotencyKey(ctx, "avec_confirm", input);
    if (!key) return NO_JOB;
    return write(ctx, async () => {
      const day = await confirmAppointment(ready.config, {
        appointmentId: input.appointment_id,
        phone: ready.phone,
        idempotencyKey: key,
      });
      return {
        ok: true,
        agendamentos: day.map((a) => ({ ...appointmentView(a), data_br: dataBr(a.date) })),
        total: day.length,
      };
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
      // The old slot is free now: it may be someone's on the waitlist.
      dispararBuscaDaEspera(ctx.organizationId);
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
  nome_completo: z
    .string()
    .trim()
    .min(3)
    .max(120)
    .optional()
    .describe(
      "Nome completo de quem vai ser atendida, só quando a cliente disse (ex.: é para a filha) ou quando esta ferramenta pediu.",
    ),
};

export const avecBook: McpToolDefinition<typeof bookShape> = {
  name: "avec_book",
  description:
    "Marca no avec a visita de uma opção de avec_free_slots para a cliente DESTA conversa, pelo " +
    "telefone dela, com todas as etapas (ex.: corte, lavagem e secagem). Antes: confirme com " +
    "ela o serviço, o dia, a hora e a profissional, e espere o sim. Se o horário for para outra " +
    "pessoa (filha, mãe), mande o nome completo dela em nome_completo. Se o avec não conhecer a " +
    "cliente, a resposta pede para passar para a equipe cadastrá-la.",
  inputSchema: bookShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  redigirParaAuditoria: (args) => redactFreeText("nome_completo")(redactFreeText("note")(args)),
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
    const marcada = await marcarVisita(ctx, ready, salao, opcao, {
      tool: "avec_book",
      opcaoId: input.opcao_id,
      note: input.note,
      nomeCompleto: input.nome_completo,
      repetir: "avec_book de novo com o mesmo opcao_id e nome_completo",
    });
    if (!marcada.ok) return marcada.falha;
    // She booked the service she was waiting for: her entry leaves the waitlist.
    void encerrarAoMarcar(ctx.organizationId, ctx.contatoDoTurno!, opcao.oferta.id, new Date());
    return visitaMarcadaView(salao, opcao, marcada.feitos);
  },
};

type FalhaDaMarcacao = { ok: false; code: string } & Record<string, unknown>;

/**
 * Books every step of a visit option in avec, in the recipe's order. Shared by `avec_book` and
 * the waitlist's acceptance; the idempotency keys keep the `avec_book` format.
 */
async function marcarVisita(
  ctx: McpContext,
  ready: { config: AvecConfig; phone: string; name: string | null },
  salao: Salao,
  opcao: NonNullable<ReturnType<typeof validarOpcao>>,
  opts: { tool: string; opcaoId: string; note?: string; nomeCompleto?: string; repetir: string },
): Promise<{ ok: true; feitos: AvecAppointment[] } | { ok: false; falha: FalhaDaMarcacao }> {
  const feitos: AvecAppointment[] = [];
  for (const [i, slot] of opcao.slots.entries()) {
    // The name is in the key: after "which of the two records?", the retry is another write.
    const key = avecIdempotencyKey(ctx, opts.tool, {
      opcao_id: opts.opcaoId,
      etapa: i,
      nome: opts.nomeCompleto ?? null,
    })!;
    try {
      feitos.push(
        await createAppointment(ready.config, {
          phone: ready.phone,
          // Who the client said will be served must match the record; the WhatsApp name only
          // breaks a tie between records of the phone (Berseba/berseba-mayara-morales#28, #29).
          clientName: opts.nomeCompleto ?? ready.name ?? undefined,
          nameMustMatch: Boolean(opts.nomeCompleto),
          slotId: slot.slotId,
          note: i === 0 ? opts.note : undefined,
          idempotencyKey: key,
        }),
      );
    } catch (err) {
      if (i === 0) {
        if (err instanceof AvecApiError && err.code === "ambiguous_client" && !opts.nomeCompleto) {
          // Be proactive before handing off: the full name usually tells which record it is.
          return {
            ok: false,
            falha: {
              ok: false,
              code: err.code,
              handoff: false,
              mensagem:
                'o salão tem mais de uma ficha com este telefone. Pergunte com naturalidade: "Pra ' +
                'eu confirmar aqui, qual é o nome completo de quem vai ser atendida?" e chame ' +
                `${opts.repetir}.`,
            },
          };
        }
        const twice =
          err instanceof AvecApiError && err.code === "slot_unavailable" && slotTakenBefore(ctx);
        return { ok: false, falha: failure(err, { slotTakenTwice: twice, isWrite: true }) as FalhaDaMarcacao };
      }
      logger.warn("avec: visit booked in part", {
        step: i,
        code: err instanceof AvecApiError ? err.code : "unexpected",
      });
      const hhmm = `${String(Math.floor(slot.inicio / 60)).padStart(2, "0")}:${String(slot.inicio % 60).padStart(2, "0")}`;
      return {
        ok: false,
        falha: {
          ok: false,
          code: err instanceof AvecApiError ? err.code : "internal_error",
          handoff: true,
          parcial: true,
          mensagem:
            "a visita ficou marcada só em parte. Não confirme o horário à cliente: diga que a " +
            "nossa equipe de atendimento finaliza o agendamento e já responde por aqui. " +
            HANDOFF_INSTRUCTION,
          todo:
            `Ficou marcado no avec: ${feitos.map((f) => `${f.service ?? "serviço"} ${dataBr(f.date)} ${f.start_time} (${f.professional ?? ""})`).join("; ")}. ` +
            `Falta marcar a etapa ${i + 1} de ${opcao.oferta.rotulo} às ${hhmm} (${nomeDe(salao, slot.profissional) ?? "auxiliar"}): conferir e completar no avec, depois confirmar com a cliente.`,
        },
      };
    }
  }
  return { ok: true, feitos };
}

function visitaMarcadaView(
  salao: Salao,
  opcao: NonNullable<ReturnType<typeof validarOpcao>>,
  feitos: AvecAppointment[],
) {
  const first = feitos[0]!;
  return {
    ok: true as const,
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
}

// ---------------------------------------------------------------------------
// waitlist (lib/integrations/avec/lista-de-espera*.ts)
// ---------------------------------------------------------------------------

const hora = z
  .string()
  .regex(/^\d{2}:\d{2}$/, "use HH:MM")
  .optional();

const waitlistShape = {
  acao: z
    .enum(["entrar", "aceitar", "recusar", "sair"])
    .describe("aceitar = ela disse SIM à vaga oferecida; recusar = não quer essa vaga; sair = não quer mais a lista."),
  servico: z.string().trim().max(40).optional().describe("Código de avec_find_services."),
  comprimento: z.enum(["curto", "medio", "longo", "extra_longo"]).optional(),
  profissional: z.string().trim().max(60).optional().describe("Só se ela pediu uma."),
  data_de: date.describe("Primeiro dia em que ela pode vir."),
  data_ate: date.describe("Último dia (um dia só: igual a data_de)."),
  depois_de: hora.describe('Começar a partir de, ex.: "14:00".'),
  ate: hora.describe('Começar no máximo até, ex.: "11:00".'),
  substitui_data: date.describe("Se ela quer adiantar um horário que já tem: o dia dele (cancelado no SIM)."),
  observacao: freeText("Algo que a equipe precisa saber."),
};

type PedidoDaTool = { servico: string; comprimento: Comprimento | null; profissional: string | null };

const LISTA_DESLIGADA = {
  ok: false,
  handoff: false,
  motivo: "lista_desligada",
  mensagem:
    "a lista de espera não está ligada neste salão. Não ofereça lista de espera: siga a regra de quando não há horário.",
};

export const avecWaitlist: McpToolDefinition<typeof waitlistShape> = {
  name: "avec_waitlist",
  description:
    "Lista de espera do salão para a cliente DESTA conversa. entrar: sem o horário que ela quer, " +
    "ofereça antes o mais próximo; se ela preferir esperar (ou adiantar um horário que já tem), " +
    "coloque com serviço, dias e faixa de horário. Quando abrir vaga, o sistema chama uma pessoa " +
    "por vez aqui, com prazo. aceitar: ela respondeu SIM à vaga; marca e confirma no avec.",
  inputSchema: waitlistShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  redigirParaAuditoria: redactFreeText("observacao"),
  handler: async (input, ctx) => {
    const ready = await prepare(ctx);
    if ("ok" in ready) return ready;
    const salao = salaoDa(ctx.organizationId);
    if (!salao) return SEM_OFERTAS;
    const admin = createAdminClient();
    const org = ctx.organizationId;
    const contato = ctx.contatoDoTurno!;
    const config = await configDaEsperaAvec(admin, org);
    if (!config) return LISTA_DESLIGADA;
    const agora = new Date();
    try {
      if (input.acao === "entrar") return await entrarNaLista(ctx, ready, salao, admin, config, input, agora);
      if (input.acao === "aceitar") return await aceitarVaga(ctx, ready, salao, admin, agora);
      if (input.acao === "recusar") {
        const oferta = await ofertaAbertaDe(admin, org, contato);
        if (!oferta) return SEM_OFERTA_ABERTA;
        await repoSupabase(admin).voltarParaFila(org, oferta.id, oferta.chave, agora);
        dispararBuscaDaEspera(org);
        return {
          ok: true,
          mensagem: "ela continua na lista para outras vagas. Diga isso a ela com carinho.",
        };
      }
      // sair
      let saida = admin
        .from("avec_waitlist")
        .update({ status: "cancelled", encerrada_em: agora.toISOString(), updated_at: agora.toISOString() })
        .eq("organization_id", org)
        .eq("contact_id", contato)
        .in("status", ["waiting", "offered"]);
      if (input.servico) saida = saida.eq("pedido->>servico", input.servico);
      const { data, error } = await saida.select("id, status");
      if (error) throw new Error(error.message);
      dispararBuscaDaEspera(org);
      return { ok: true, removidas: (data ?? []).length };
    } catch (err) {
      return failure(err);
    }
  },
};

const SEM_OFERTA_ABERTA = {
  ok: false,
  handoff: false,
  motivo: "sem_oferta",
  mensagem:
    "não há vaga da lista de espera oferecida a ela agora. Se ela quer marcar, busque com avec_free_slots.",
};

async function ofertaAbertaDe(
  admin: ReturnType<typeof createAdminClient>,
  org: string,
  contato: string,
): Promise<{ id: string; chave: string | null; expira: Date; oferta: OfertaGuardada; substituiData: string | null } | null> {
  const { data, error } = await admin
    .from("avec_waitlist")
    .select("id, oferta, oferta_chave, oferta_expira_em, substitui_data")
    .eq("organization_id", org)
    .eq("contact_id", contato)
    .eq("status", "offered")
    .order("ofertada_em", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const linha = (data ?? [])[0] as Record<string, unknown> | undefined;
  const oferta = lerOferta(linha?.oferta);
  if (!linha || !oferta || typeof linha.oferta_expira_em !== "string") return null;
  return {
    id: String(linha.id),
    chave: typeof linha.oferta_chave === "string" ? linha.oferta_chave : null,
    expira: new Date(linha.oferta_expira_em),
    oferta,
    substituiData: typeof linha.substitui_data === "string" ? linha.substitui_data : null,
  };
}

async function entrarNaLista(
  ctx: McpContext,
  ready: { config: AvecConfig; phone: string; name: string | null },
  salao: Salao,
  admin: ReturnType<typeof createAdminClient>,
  config: ConfigDaListaDeEspera,
  input: z.infer<z.ZodObject<typeof waitlistShape>>,
  agora: Date,
) {
  const hoje = hojeEmBrasilia(agora);
  if (!input.servico || !input.data_de) {
    return {
      ok: false,
      handoff: false,
      mensagem: "para entrar na lista, mande servico e data_de (e data_ate, se ela pode em mais de um dia).",
    };
  }
  const dataAte = input.data_ate ?? input.data_de;
  if (input.data_de < hoje || dataAte < input.data_de || dataAte > addDays(hoje, MAX_DIAS_A_FRENTE)) {
    return {
      ok: false,
      handoff: false,
      mensagem: `confira os dias com a cliente: de hoje (${dataBr(hoje)}) em diante, até ${MAX_DIAS_A_FRENTE} dias.`,
    };
  }
  if (input.depois_de && input.ate && input.ate < input.depois_de) {
    return { ok: false, handoff: false, mensagem: "a faixa de horário está invertida: confira com a cliente." };
  }
  const pedidoBruto: PedidoDaTool = {
    servico: input.servico,
    comprimento: input.comprimento ?? null,
    profissional: input.profissional ?? null,
  };
  const conferido = conferirPedido(salao, pedidoBruto);
  if (!conferido.ok) {
    const oferta = ofertaPorId(salao, input.servico);
    const mensagens: Record<string, string> = {
      servico_desconhecido: "serviço desconhecido: use o campo servico de avec_find_services.",
      precisa_comprimento:
        "este serviço depende do comprimento do cabelo: pergunte se é curto, médio, longo ou extra longo.",
      profissional_nao_faz: `essa profissional não faz este serviço aqui. Quem faz: ${(oferta?.porProfissional ?? [])
        .map((p) => nomeDe(salao, p.profissional))
        .join(", ")}. Pergunte à cliente.`,
      comprimento_com_a_equipe: "esse comprimento fica com a equipe: " + HANDOFF_INSTRUCTION,
    };
    return {
      ok: false,
      handoff: conferido.motivo === "comprimento_com_a_equipe",
      mensagem: mensagens[conferido.motivo],
    };
  }
  // A named professional is stored by id; "any" stays null.
  const pedido = {
    servico: input.servico,
    comprimento: conferido.comprimento,
    profissional: input.profissional && conferido.principais.length === 1 ? conferido.principais[0]! : null,
  };
  const inscricao: InscricaoAvec = {
    id: "nova",
    contactId: ctx.contatoDoTurno!,
    pedido,
    dataDe: input.data_de,
    dataAte,
    depoisDe: input.depois_de ?? null,
    ate: input.ate ?? null,
    substituiData: input.substitui_data ?? null,
    ordem: 0,
    createdAt: agora,
    recusadas: [],
  };

  // A slot that serves her already exists: offer it now instead of making her wait.
  const janela = janelaDeBusca(inscricao, hoje);
  if (janela) {
    const opcoes = (await opcoesDoPedido(ready.config, salao, pedido, janela.de, janela.ate)) ?? [];
    const seguradas = await ocupacoesSeguradasPorOutras(admin, ctx.organizationId, ctx.contatoDoTurno!, agora);
    const livres = opcoes
      .filter((o) => motivoParaNaoServir(inscricao, o, seguradas, agora, config) === null)
      .sort((a, b) => a.data.localeCompare(b.data) || a.inicio.localeCompare(b.inicio))
      .slice(0, MAX_OPCOES);
    if (livres.length) {
      return {
        ok: false,
        handoff: false,
        motivo: "ha_horario",
        mensagem:
          "há horário livre no que ela pediu: ofereça estas opções (para marcar, avec_book com o opcao_id). " +
          "Só coloque na lista se ela não quiser nenhuma.",
        opcoes: livres.map((o) => opcaoView(salao, o)),
      };
    }
  }

  const linha = {
    pedido,
    data_de: input.data_de,
    data_ate: dataAte,
    depois_de: input.depois_de ?? null,
    ate: input.ate ?? null,
    substitui_data: input.substitui_data ?? null,
    observacoes: input.observacao ?? null,
    updated_at: agora.toISOString(),
  };
  const { data: existente, error: erroLeitura } = await admin
    .from("avec_waitlist")
    .select("id")
    .eq("organization_id", ctx.organizationId)
    .eq("contact_id", ctx.contatoDoTurno!)
    .eq("pedido->>servico", pedido.servico)
    .in("status", ["waiting", "offered"])
    .limit(1);
  if (erroLeitura) throw new Error(erroLeitura.message);
  const jaEstava = (existente ?? [])[0] as { id: string } | undefined;
  const { error } = jaEstava
    ? await admin
        .from("avec_waitlist")
        .update(linha)
        .eq("organization_id", ctx.organizationId)
        .eq("id", jaEstava.id)
    : await admin.from("avec_waitlist").insert({
        ...linha,
        organization_id: ctx.organizationId,
        contact_id: ctx.contatoDoTurno!,
        created_by_kind: "ai",
      });
  if (error) throw new Error(error.message);
  return {
    ok: true,
    inscricao: {
      servico: ofertaPorId(salao, pedido.servico)?.rotulo ?? pedido.servico,
      profissional: pedido.profissional ? nomeDe(salao, pedido.profissional) : "qualquer profissional",
      dias: input.data_de === dataAte ? dataBr(input.data_de) : `${dataBr(input.data_de)} a ${dataBr(dataAte)}`,
      horario:
        input.depois_de || input.ate
          ? [input.depois_de ? `a partir das ${input.depois_de}` : null, input.ate ? `até as ${input.ate}` : null]
              .filter(Boolean)
              .join(" ")
          : "qualquer horário",
      ...(input.substitui_data ? { adiantar_o_horario_de: dataBr(input.substitui_data) } : {}),
      ja_estava_na_lista: Boolean(jaEstava),
    },
    mensagem:
      "Diga que ela está na lista de espera e que, se abrir um horário, você chama aqui na hora. " +
      "Não prometa que vai abrir.",
  };
}

async function aceitarVaga(
  ctx: McpContext,
  ready: { config: AvecConfig; phone: string; name: string | null },
  salao: Salao,
  admin: ReturnType<typeof createAdminClient>,
  agora: Date,
) {
  const org = ctx.organizationId;
  const aberta = await ofertaAbertaDe(admin, org, ctx.contatoDoTurno!);
  if (!aberta) return SEM_OFERTA_ABERTA;
  if (aberta.expira.getTime() <= agora.getTime()) {
    return {
      ok: false,
      handoff: false,
      motivo: "oferta_vencida",
      mensagem:
        "o prazo dessa vaga já passou e ela pode ter ido para a próxima da lista. Peça desculpas e busque " +
        "horários com avec_free_slots.",
    };
  }
  const opcao = validarOpcao(salao, aberta.oferta.opcao_id);
  if (!opcao) return failure(new Error("avec_waitlist: stored offer no longer matches the recipes"));
  if (!avecIdempotencyKey(ctx, "avec_waitlist", { espera: aberta.id })) return NO_JOB;

  const marcada = await marcarVisita(ctx, ready, salao, opcao, {
    tool: "avec_waitlist",
    opcaoId: aberta.oferta.opcao_id,
    note: "Encaixe da lista de espera",
    repetir: 'avec_waitlist de novo com acao "aceitar"',
  });
  if (!marcada.ok) {
    if (marcada.falha.code === "slot_unavailable") {
      await repoSupabase(admin).voltarParaFila(org, aberta.id, aberta.chave, agora);
      return {
        ok: false,
        handoff: false,
        motivo: "vaga_perdida",
        mensagem:
          "alguém ocupou esse horário antes. Peça desculpas com carinho: ela continua na lista e você chama " +
          "de novo quando abrir outro.",
      };
    }
    return marcada.falha;
  }

  const avisos: string[] = [];
  const first = marcada.feitos[0]!;
  try {
    await confirmAppointment(ready.config, {
      appointmentId: first.id,
      phone: ready.phone,
      idempotencyKey: avecIdempotencyKey(ctx, "avec_waitlist", { espera: aberta.id, confirmar: true })!,
    });
  } catch (err) {
    logger.warn("avec_waitlist: booked but not confirmed", {
      code: err instanceof AvecApiError ? err.code : "unexpected",
    });
    avisos.push("O horário ficou marcado, mas não consegui deixar como Confirmado no avec.");
  }

  const canceladas: string[] = [];
  let todo: string | null = null;
  if (aberta.substituiData && aberta.substituiData !== first.date) {
    try {
      const antigas = (
        await listAppointments(ready.config, {
          phone: ready.phone,
          from: aberta.substituiData,
          to: aberta.substituiData,
        })
      ).filter((a) => a.status !== null && CHANGEABLE_STATUS.has(a.status));
      for (const a of antigas) {
        await cancelAppointment(ready.config, {
          appointmentId: a.id,
          phone: ready.phone,
          reason: "Adiantado pela lista de espera",
          idempotencyKey: avecIdempotencyKey(ctx, "avec_waitlist", { espera: aberta.id, cancelar: a.id })!,
        });
        canceladas.push(`${a.service ?? "serviço"} ${dataBr(a.date)} ${a.start_time}`);
      }
    } catch (err) {
      logger.warn("avec_waitlist: old visit not cancelled", {
        code: err instanceof AvecApiError ? err.code : "unexpected",
      });
      todo = `Cancelar no avec o horário antigo da cliente em ${dataBr(aberta.substituiData)} (ela foi encaixada antes pela lista de espera).`;
    }
  }

  const { error } = await admin
    .from("avec_waitlist")
    .update({
      status: "booked",
      resultado: {
        agendamentos: marcada.feitos.map((f) => f.id),
        data: first.date,
        inicio: first.start_time,
        canceladas,
      },
      encerrada_em: agora.toISOString(),
      updated_at: agora.toISOString(),
    })
    .eq("organization_id", org)
    .eq("id", aberta.id);
  if (error) logger.warn("avec_waitlist: booked but the entry was not closed", { error: error.message });
  if (canceladas.length) dispararBuscaDaEspera(org);

  return {
    ...visitaMarcadaView(salao, opcao, marcada.feitos),
    ...(canceladas.length ? { horario_antigo_cancelado: canceladas } : {}),
    ...(avisos.length ? { avisos } : {}),
    ...(todo ? { handoff: true, todo, mensagem: "confirme o novo horário à cliente. " + HANDOFF_INSTRUCTION } : {}),
  };
}
