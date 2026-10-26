/**
 * Berseba: agenda tools over Mirae, for Fiore Pilates (agent "Mi").
 *
 * Mirae is the studio's agenda SaaS, with a REST API v1 and one key per studio
 * (`lib/integrations/mirae/client.ts`). The studio's rules (schedule, duration, notice, horizon,
 * students per slot, how late a change may be made) are Mirae configuration: Mirae ranks the
 * slots and returns at most 2, and these tools only relay what it answers. Nothing here keeps or
 * fixes a rule.
 *
 * Same three rules as the avec tools (`./avec.ts`):
 *  - THE PHONE NEVER COMES FROM THE MODEL. It is the phone of `ctx.contatoDoTurno`, read with
 *    `organization_id = ctx.organizationId`, sent as digits only. Mirae only shows and changes
 *    the appointments of that phone. No contact of the turn (HTTP route, external MCP) = refused.
 *  - Only the organizations in `MIRAE_API_ORG_IDS` (install level) have these tools.
 *  - A failure the agent cannot fix answers `{ok: false, code, handoff: true, todo}`: the agent
 *    tells the client the team will continue and hands off with `todo` in the summary. A write
 *    without an answer is retried once with the SAME key, never with a new one.
 *
 * An evaluation booked with success also moves the client's card (`evaluation-stage.ts`).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  MiraeApiError,
  cancelAppointment,
  createAppointment,
  getBookingRules,
  listAppointments,
  listAvailability,
  listPlans,
  rescheduleAppointment,
  type MiraeAppointment,
  type MiraeService,
  type MiraeSlot,
} from "@/lib/integrations/mirae/client";
import { miraeConfigFor, type MiraeConfig } from "@/lib/integrations/mirae/config";
import { moveCardOnEvaluationBooked } from "@/lib/integrations/mirae/evaluation-stage";
import { logger } from "@/lib/logger";

import type { McpContext, McpToolDefinition } from "../types";

/** Mirae ranks the slots; this is only the ceiling of what reaches the model. */
export const MIRAE_MAX_OPCOES = 2;
const SLOT_TAKEN_TTL_MS = 30 * 60_000;

const HANDOFF_INSTRUCTION =
  "Não tente de novo. Diga à pessoa, sem falar de erro nem de sistema, que a nossa equipe vai " +
  "confirmar e já responde por aqui. Depois passe para a equipe (request_human_handoff) com um " +
  "resumo do pedido (serviço, dia e período) e o que a equipe precisa fazer (o campo todo).";

/** What the team must do, per code; the agent puts it in the handoff summary. */
const TODO_BY_CODE: Record<string, string> = {
  is_student: "Aluna pedindo avaliação/reavaliação.",
  no_balance: "Quer aula; sem plano ativo com aula sobrando.",
  ambiguous_person: "Mais de um cadastro no Mirae com este telefone: confirmar quem é e marcar.",
  slot_unavailable: "Horários mudando; marcar à mão.",
  service_not_supported: "Quer um atendimento que a API não marca, remarca nem cancela.",
  contato_sem_telefone: "O contato não tem telefone no CRM: ver a agenda pelo nome e marcar.",
  write_unconfirmed: "Conferir no Mirae se a alteração entrou; não repetir pelo sistema.",
};
const TODO_DEFAULT = "O Mirae não respondeu: fazer pela agenda o que a pessoa pediu.";

/** Codes that mean the key or the studio's Mirae setup is wrong: the CRM team must know. */
const INTEGRATION_CODES = new Set([
  "unauthorized",
  "organization_not_allowed",
  "insufficient_scope",
  "product_disabled",
  // Bugs of this client: Mirae refused the request it built.
  "invalid_request",
  "idempotency_key_reused",
  "invalid_response",
]);

/** Services Mirae does not book through the API; the agent hands them off without calling it. */
const COM_A_EQUIPE = ["massagem", "fisioterapia", "drenagem", "outros atendimentos"];

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

function refusal(motivo: string, handoff: boolean, mensagem: string, todo?: string): Refusal {
  return {
    ok: false,
    permitido: false,
    motivo,
    handoff,
    mensagem,
    ...(handoff ? { todo: todo ?? TODO_BY_CODE[motivo] ?? TODO_DEFAULT } : {}),
  };
}

/** The turn contact's phone (digits only) and name. Never from the args. */
async function turnContact(
  ctx: McpContext,
): Promise<{ phone: string | null; name: string | null }> {
  const { data, error } = await ctx.supabase
    .from("contacts")
    .select("phone_number, name")
    .eq("organization_id", ctx.organizationId)
    .eq("id", ctx.contatoDoTurno!)
    .maybeSingle<{ phone_number: string | null; name: string | null }>();
  if (error) throw new Error(`mirae: contact lookup failed: ${error.message}`);
  const digits = data?.phone_number?.replace(/\D/g, "") ?? "";
  return { phone: digits.length >= 10 ? digits : null, name: data?.name?.trim() || null };
}

interface Ready {
  config: MiraeConfig;
  phone: string;
  /** The contact's name in the CRM; Mirae creates the lead with it on an evaluation. */
  name: string | null;
}

/** Org gate + trusted phone. Returns the refusal to hand the model when either is missing. */
async function prepare(ctx: McpContext): Promise<Ready | Refusal> {
  const config = miraeConfigFor(ctx.organizationId);
  if (!config) {
    return refusal(
      "mirae_indisponivel",
      false,
      "esta ferramenta não está disponível nesta empresa.",
    );
  }
  if (!ctx.contatoDoTurno) {
    return refusal(
      "sem_contato_do_turno",
      false,
      "esta ferramenta só funciona dentro de uma conversa com a pessoa.",
    );
  }
  const { phone, name } = await turnContact(ctx);
  if (!phone) {
    return refusal(
      "contato_sem_telefone",
      true,
      "não sei o telefone desta pessoa, então não consigo consultar a agenda. " +
        HANDOFF_INSTRUCTION,
    );
  }
  return { config, phone, name };
}

function alertIntegration(ctx: McpContext, code: string, status: number): void {
  logger.error("mirae: integration failure", {
    organization_id: ctx.organizationId,
    code,
    status,
  });
  void import("@sentry/nextjs")
    .then((Sentry) => {
      Sentry.captureMessage(`[mirae] falha na integração: ${code}`, {
        level: "error",
        tags: { subsystem: "mirae", code },
        extra: { organization_id: ctx.organizationId, status },
      });
    })
    .catch(() => {
      /* no Sentry configured: the logger line above is what remains */
    });
}

/** Today in Brasília, `YYYY-MM-DD`. */
export function todayInBrasilia(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now);
}

/** `27/10`: the agent repeats this, never computes it. */
const dataBr = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
/** `HH:MM` of an ISO date-time with offset, as Mirae writes it (`...T15:50:00-03:00`). */
const hhmm = (iso: string) => iso.slice(11, 16);

const SERVICO_DE: Record<string, string> = {
  evaluation: "avaliação inicial",
  class: "aula",
  other: "outro atendimento",
};

function appointmentView(a: MiraeAppointment) {
  return {
    appointment_id: a.id,
    servico: SERVICO_DE[a.service] ?? a.service,
    dia_semana: a.weekday,
    data: a.date,
    data_br: dataBr(a.date),
    inicio: a.time,
    termina: hhmm(a.ends_at),
    profissional: a.professional?.first_name ?? null,
    status: a.status,
    pode_mudar: a.can_change,
  };
}

/**
 * The `Idempotency-Key` of a write: stable per intended write, so a retry of the same job replays
 * Mirae's first answer instead of writing twice. The body is in the key because Mirae refuses one
 * key with two bodies (`idempotency_key_reused`), and in one turn the agent may try a second slot
 * after the first was taken. 8 to 128 visible characters, per Mirae's contract.
 */
export function miraeIdempotencyKey(ctx: McpContext, tool: string, body: unknown): string | null {
  const job = ctx.sourceJobId ?? ctx.idempotencyKey;
  if (!job) return null;
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  return `mirae:${job}:${tool}:${hash}`.slice(0, 128);
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

export function resetMiraeSlotTakenForTests(): void {
  slotTaken.clear();
}

const ASK_FULL_NAME =
  "a agenda tem mais de um cadastro com este telefone. Pergunte com naturalidade o nome " +
  "completo de quem vai ser atendida e chame de novo com nome_completo.";

/** `too_late`: the summary names the studio's own deadline, read from Mirae, best effort. */
async function tooLateTodo(
  ready: Ready,
  appointmentId: string | undefined,
  verbo: string,
): Promise<string> {
  const [rules, list] = await Promise.allSettled([
    getBookingRules(ready.config),
    appointmentId ? listAppointments(ready.config, { phone: ready.phone }) : Promise.reject(),
  ]);
  const horas = rules.status === "fulfilled" ? rules.value.cancellation_min_hours : null;
  const a =
    list.status === "fulfilled" ? list.value.data.find((x) => x.id === appointmentId) : undefined;
  const qual = a
    ? `${SERVICO_DE[a.service] ?? a.service} de ${dataBr(a.date)} às ${a.time}`
    : "o horário";
  return `Quer ${verbo} ${qual}; faltam menos de ${horas ?? "N"} h.`;
}

interface FailureOptions {
  ctx: McpContext;
  ready: Ready;
  /** The write had no answer twice (same key): Mirae may have written it. */
  unconfirmed?: boolean;
  nameGiven?: boolean;
  appointmentId?: string;
  verbo?: string;
}

/** What each Mirae `code` means for the agent; anything else hands off with the default todo. */
async function failure(err: unknown, o: FailureOptions) {
  if (!(err instanceof MiraeApiError)) {
    logger.warn("mirae: unexpected tool failure", {
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
  logger.warn("mirae: API refused", { status: err.status, code: err.code });
  const teach = (mensagem: string) => ({ ok: false, code: err.code, handoff: false, mensagem });
  const handOff = (todo: string, prefix = "") => ({
    ok: false,
    code: err.code,
    handoff: true,
    mensagem: prefix + HANDOFF_INSTRUCTION,
    todo,
  });

  if (o.unconfirmed) {
    return handOff(
      TODO_BY_CODE.write_unconfirmed!,
      "a agenda pode ter gravado essa alteração, mas a resposta se perdeu. ",
    );
  }
  if (INTEGRATION_CODES.has(err.code)) {
    alertIntegration(o.ctx, err.code, err.status);
    return handOff(`Falha na integração com o Mirae (${err.code}).`);
  }
  switch (err.code) {
    case "slot_unavailable":
      return slotTakenBefore(o.ctx)
        ? handOff(TODO_BY_CODE.slot_unavailable!)
        : teach(
            "alguém acabou de pegar esse horário. Busque de novo com mirae_free_slots e ofereça " +
              "as opções que vierem.",
          );
    case "already_booked":
      return teach(
        `ela já tem avaliação marcada${err.startsAt ? ` em ${dataBr(err.startsAt.slice(0, 10))} às ${hhmm(err.startsAt)}` : ""}. ` +
          "Diga isso e ofereça remarcar: mirae_my_appointments, depois mirae_free_slots com " +
          "remarcar_appointment_id.",
      );
    case "ambiguous_person":
      return o.nameGiven ? handOff(TODO_BY_CODE.ambiguous_person!) : teach(ASK_FULL_NAME);
    case "person_not_found":
      return teach(
        "a aula é só para quem já é aluna do estúdio. Ofereça a avaliação inicial " +
          "(mirae_free_slots com servico avaliacao). Se ela disser que já é aluna, passe para a equipe.",
      );
    case "not_found":
    case "not_changeable":
      return teach(
        "esse agendamento não está mais marcado para esta pessoa. Busque de novo com " +
          "mirae_my_appointments e use o appointment_id que vier lá.",
      );
    case "too_late":
      return handOff(
        await tooLateTodo(o.ready, o.appointmentId, o.verbo ?? "mudar"),
        "faltando pouco para o horário, quem remarca ou cancela é a equipe. ",
      );
    default:
      return handOff(TODO_BY_CODE[err.code] ?? TODO_DEFAULT);
  }
}

/** A write: one retry with the SAME key when there was no answer or a 5xx, never a new key. */
async function write<T>(
  run: () => Promise<T>,
  o: Omit<FailureOptions, "unconfirmed">,
): Promise<T | Awaited<ReturnType<typeof failure>>> {
  const lost = (err: unknown) =>
    err instanceof MiraeApiError && (err.status === 0 || err.status >= 500);
  try {
    return await run();
  } catch (first) {
    if (!lost(first)) return failure(first, o);
    try {
      return await run();
    } catch (second) {
      return failure(second, { ...o, unconfirmed: lost(second) });
    }
  }
}

// ---------------------------------------------------------------------------
// opcao_id: opaque to the model, signed so it cannot be edited
// ---------------------------------------------------------------------------

const opcaoSchema = z
  .object({
    s: z.enum(["evaluation", "class"]),
    t: z.iso.datetime({ offset: true }),
    p: z.string().min(1).max(100).optional(),
    /** Set only on an option for a reschedule: the appointment it moves. */
    r: z.string().min(1).max(100).optional(),
  })
  .strict();
type Opcao = z.infer<typeof opcaoSchema>;

const sign = (config: MiraeConfig, payload: string) =>
  createHmac("sha256", config.apiKey).update(payload).digest("base64url").slice(0, 22);

export function encodeOpcao(config: MiraeConfig, opcao: Opcao): string {
  const payload = Buffer.from(JSON.stringify(opcao)).toString("base64url");
  return `${payload}.${sign(config, payload)}`;
}

/** The option, or `null` for anything not minted by `mirae_free_slots` with this key. */
export function decodeOpcao(config: MiraeConfig, opcaoId: string): Opcao | null {
  const [payload, mac, ...rest] = opcaoId.trim().split(".");
  if (!payload || !mac || rest.length) return null;
  const expected = Buffer.from(sign(config, payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const parsed = opcaoSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const OPCAO_INVALIDA = {
  ok: false,
  handoff: false,
  mensagem:
    "opcao_id inválido: use exatamente um opcao_id que veio de mirae_free_slots, sem mudar nada.",
};

function opcaoView(config: MiraeConfig, s: MiraeSlot, service: MiraeService, r?: string) {
  return {
    opcao_id: encodeOpcao(config, {
      s: service,
      t: s.starts_at,
      p: s.professional.id,
      ...(r ? { r } : {}),
    }),
    dia_semana: s.weekday,
    data: s.date,
    data_br: dataBr(s.date),
    inicio: s.time,
    termina: hhmm(s.ends_at),
    profissional: s.professional.first_name,
    ...(s.spots_left !== undefined ? { vagas: s.spots_left } : {}),
  };
}

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "use AAAA-MM-DD")
  .optional()
  .describe("Data no formato AAAA-MM-DD (fuso de Brasília).");

const nomeCompleto = z
  .string()
  .trim()
  .min(3)
  .max(120)
  .optional()
  .describe(
    "Nome completo de quem vai ser atendida, só quando a ferramenta pediu (mais de um cadastro no telefone) ou quando o horário é para outra pessoa.",
  );

const appointmentId = (from: string) =>
  z.string().trim().min(1).max(100).describe(`O appointment_id que veio de ${from}.`);

// The client's name never goes to `api_audit_log`.
function redactName(args: Record<string, unknown>) {
  return typeof args.nome_completo === "string" ? { ...args, nome_completo: "[redacted]" } : args;
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

const myAppointmentsShape = { from: date, to: date, nome_completo: nomeCompleto };

export const miraeMyAppointments: McpToolDefinition<typeof myAppointmentsShape> = {
  name: "mirae_my_appointments",
  description:
    "Lista a avaliação e as aulas marcadas da pessoa DESTA conversa na agenda do estúdio " +
    "(Mirae), pelo telefone dela (você não informa telefone), e diz quem ela é para o estúdio " +
    "em pessoa.etapa: lead (interessada), student (aluna) ou former_student (ex-aluna); " +
    "pessoa null = ninguém com esse telefone. Use antes de buscar avaliação, e antes de " +
    "remarcar ou cancelar, para pegar o appointment_id. Se vier mais de um, pergunte qual. Só os " +
    "de pode_mudar: true podem ser remarcados ou cancelados; os outros, passe para a equipe.",
  inputSchema: myAppointmentsShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  redigirParaAuditoria: redactName,
  handler: async (input, ctx) => {
    const ready = await prepare(ctx);
    if ("ok" in ready) return ready;
    try {
      // Field by field, never a spread: nothing in the args may reach the API as the phone.
      const r = await listAppointments(ready.config, {
        phone: ready.phone,
        name: input.nome_completo,
        from: input.from,
        to: input.to,
      });
      return {
        ok: true,
        pessoa: r.person ? { primeiro_nome: r.person.first_name, etapa: r.person.stage } : null,
        agendamentos: r.data.map(appointmentView),
      };
    } catch (err) {
      return failure(err, { ctx, ready, nameGiven: Boolean(input.nome_completo) });
    }
  },
};

const brl = (cents: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })
    .format(cents / 100)
    .replace(/ /g, " ");

export const miraeServices: McpToolDefinition<Record<string, never>> = {
  name: "mirae_services",
  description:
    "Diz o que você marca sozinha na agenda do estúdio (avaliação inicial e aula), os planos " +
    "com valores que o estúdio libera (valor total e por mês) e as regras de prazo do estúdio. " +
    "Passe só os valores e planos que vierem daqui, sem inventar valor nem desconto. O que " +
    "está em com_a_equipe (massagem, fisioterapia e outros) é sempre com a equipe: não busque " +
    "horário, passe para a equipe.",
  inputSchema: {},
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (_input, ctx) => {
    const ready = await prepare(ctx);
    if ("ok" in ready) return ready;
    const [plans, rules] = await Promise.allSettled([
      listPlans(ready.config),
      getBookingRules(ready.config),
    ]);
    if (plans.status === "rejected") return failure(plans.reason, { ctx, ready });
    return {
      ok: true,
      servicos: ["avaliacao", "aula"],
      planos: plans.value.map((p) => ({
        nome: p.name,
        valor_br: brl(p.price_cents),
        ...(p.months
          ? { meses: p.months, por_mes_br: brl(Math.round(p.price_cents / p.months)) }
          : {}),
        aulas_por_semana: p.sessions_per_week,
      })),
      // The rules only explain; a failure to read them does not hide the plans.
      ...(rules.status === "fulfilled"
        ? {
            regras: {
              antecedencia_minima_horas: rules.value.min_notice_hours,
              agenda_aberta_dias: rules.value.horizon_days,
              remarcar_ou_cancelar_ate_horas_antes: rules.value.cancellation_min_hours,
            },
          }
        : {}),
      com_a_equipe: COM_A_EQUIPE,
    };
  },
};

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

/** The model's `servico` → Mirae's service, or `null` for anything the API does not book. */
export function serviceOf(servico: string): MiraeService | null {
  const s = fold(servico);
  if (/^(avaliacao|avaliacao inicial|evaluation)$/.test(s)) return "evaluation";
  if (/^(aula|aula de pilates|class)$/.test(s)) return "class";
  return null;
}

const PERIOD = { manha: "morning", tarde: "afternoon", noite: "evening" } as const;
const PERIODO_BR = { manha: "manhã", tarde: "tarde", noite: "noite" } as const;

const freeSlotsShape = {
  servico: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .describe('"avaliacao" (avaliação inicial) ou "aula". Outro serviço: passe para a equipe.'),
  data: date.describe(
    "Um dia exato que a pessoa pediu (AAAA-MM-DD). Sem dia, olha a agenda aberta.",
  ),
  periodo: z.enum(["manha", "tarde", "noite"]).optional().describe("Período que a pessoa pediu."),
  remarcar_appointment_id: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("Para remarcar: o appointment_id de mirae_my_appointments."),
  nome_completo: nomeCompleto,
};

export const miraeFreeSlots: McpToolDefinition<typeof freeSlotsShape> = {
  name: "mirae_free_slots",
  description:
    `Busca até ${MIRAE_MAX_OPCOES} opções de horário na agenda do estúdio (Mirae), já ` +
    "escolhidas pela regra do estúdio, para avaliação inicial ou aula. Cada opção traz dia da " +
    "semana, data, hora, profissional e um opcao_id. Ofereça exatamente as que vierem, com dia " +
    'da semana, data e hora (ex.: "terça, 27/10, às 15h com a Raquel"). Nunca ofereça horário ' +
    "que não veio daqui. Para remarcar, mande remarcar_appointment_id. Lista vazia: passe para " +
    "a equipe.",
  inputSchema: freeSlotsShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  redigirParaAuditoria: redactName,
  handler: async (input, ctx) => {
    const ready = await prepare(ctx);
    if ("ok" in ready) return ready;
    const hoje = todayInBrasilia();
    if (input.data && input.data < hoje) {
      return { ok: false, handoff: false, mensagem: "essa data já passou: confira com a pessoa." };
    }
    const nameGiven = Boolean(input.nome_completo);
    let service = serviceOf(input.servico);
    let reschedule: MiraeAppointment | undefined;
    try {
      if (input.remarcar_appointment_id) {
        const mine = await listAppointments(ready.config, {
          phone: ready.phone,
          name: input.nome_completo,
        });
        reschedule = mine.data.find((a) => a.id === input.remarcar_appointment_id);
        if (!reschedule) {
          return failure(new MiraeApiError(404, "not_found", "appointment not in the list"), {
            ctx,
            ready,
          });
        }
        if (reschedule.service !== "evaluation" && reschedule.service !== "class") {
          return failure(new MiraeApiError(422, "service_not_supported", "clinical"), {
            ctx,
            ready,
          });
        }
        if (!reschedule.can_change) {
          return failure(new MiraeApiError(409, "too_late", "can_change false"), {
            ctx,
            ready,
            appointmentId: reschedule.id,
            verbo: "remarcar",
          });
        }
        service = reschedule.service;
      }
    } catch (err) {
      return failure(err, { ctx, ready, nameGiven });
    }
    if (!service) {
      // No call: Mirae books only evaluations and classes.
      return refusal(
        "servico_com_a_equipe",
        true,
        HANDOFF_INSTRUCTION,
        `Quer ${input.servico}; a API não marca.`,
      );
    }
    try {
      const slots = await listAvailability(ready.config, {
        service,
        date: input.data,
        period: input.periodo ? PERIOD[input.periodo] : undefined,
        // A class is only for people of the studio; Mirae identifies her by the phone.
        ...(service === "class" ? { phone: ready.phone, name: input.nome_completo } : {}),
      });
      if (slots.length === 0) {
        const quando = [
          input.data ? dataBr(input.data) : null,
          input.periodo && PERIODO_BR[input.periodo],
        ]
          .filter(Boolean)
          .join(", ");
        return refusal(
          "sem_horario",
          true,
          "não encontrei horário para esse pedido. Não diga que não há horário: diga com carinho " +
            "que a nossa equipe vai ver o melhor horário e já responde por aqui, e passe para a " +
            "equipe com o pedido e o todo.",
          `Quer ${reschedule ? "remarcar " : ""}${SERVICO_DE[service]}${quando ? ` (${quando})` : ""}; sem horário na API.`,
        );
      }
      return {
        ok: true,
        opcoes: slots
          .slice(0, MIRAE_MAX_OPCOES)
          .map((s) => opcaoView(ready.config, s, service, reschedule?.id)),
      };
    } catch (err) {
      return failure(err, { ctx, ready, nameGiven });
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

function bookedView(a: MiraeAppointment) {
  return {
    appointment_id: a.id,
    servico: SERVICO_DE[a.service] ?? a.service,
    dia_semana: a.weekday,
    data_br: dataBr(a.date),
    inicio: a.time,
    termina: hhmm(a.ends_at),
    profissional: a.professional?.first_name ?? null,
  };
}

const bookShape = {
  opcao_id: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .describe("O opcao_id que veio de mirae_free_slots, exatamente como veio."),
  nome_completo: nomeCompleto,
};

export const miraeBook: McpToolDefinition<typeof bookShape> = {
  name: "mirae_book",
  description:
    "Marca na agenda do estúdio (Mirae) a avaliação inicial ou a aula de uma opção de " +
    "mirae_free_slots, para a pessoa DESTA conversa. Antes, confirme com ela o dia e a hora e " +
    "espere o sim. Só diga que está marcado depois de ok: true, repetindo dia, hora e o nome da " +
    "profissional que VOLTOU aqui (pode ser outra do mesmo horário). Avaliação marcada já move o " +
    "card da pessoa no funil.",
  inputSchema: bookShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  redigirParaAuditoria: redactName,
  handler: async (input, ctx) => {
    const ready = await prepare(ctx);
    if ("ok" in ready) return ready;
    const opcao = decodeOpcao(ready.config, input.opcao_id);
    if (!opcao) return OPCAO_INVALIDA;
    if (opcao.r) {
      return {
        ok: false,
        handoff: false,
        mensagem: "essa opção é para remarcar: use mirae_reschedule com o appointment_id dela.",
      };
    }
    const name = input.nome_completo ?? ready.name;
    if (!name || name.length < 2) {
      return {
        ok: false,
        handoff: false,
        mensagem:
          "preciso do nome de quem vai ser atendida para marcar. Pergunte o nome completo e " +
          "chame de novo com nome_completo.",
      };
    }
    const body = {
      service: opcao.s,
      startsAt: opcao.t,
      professionalId: opcao.p,
      phone: ready.phone,
      name,
    };
    const key = miraeIdempotencyKey(ctx, "mirae_book", body);
    if (!key) return NO_JOB;
    const booked = await write(
      () => createAppointment(ready.config, { ...body, idempotencyKey: key }),
      {
        ctx,
        ready,
        nameGiven: Boolean(input.nome_completo),
      },
    );
    if ("ok" in booked) return booked;
    // Deterministic, not left to the model: the evaluation moves the card (`evaluation-stage.ts`).
    if (booked.service === "evaluation") await moveCardOnEvaluationBooked(ctx);
    return {
      ok: true,
      agendamento: bookedView(booked),
      ...(opcao.p && booked.professional && booked.professional.id !== opcao.p
        ? {
            aviso:
              "a profissional mudou para outra do mesmo horário: confirme com a pessoa o nome que voltou.",
          }
        : {}),
    };
  },
};

const rescheduleShape = {
  appointment_id: appointmentId("mirae_my_appointments"),
  opcao_id: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .describe("O opcao_id que veio de mirae_free_slots com remarcar_appointment_id."),
  nome_completo: nomeCompleto,
};

export const miraeReschedule: McpToolDefinition<typeof rescheduleShape> = {
  name: "mirae_reschedule",
  description:
    "Remarca a avaliação ou a aula da pessoa DESTA conversa na agenda do estúdio (Mirae). " +
    "Antes: mirae_free_slots com remarcar_appointment_id e confirme com ela o novo dia e hora. " +
    "Depois de remarcar, o appointment_id pode mudar: use o deste resultado daqui em diante.",
  inputSchema: rescheduleShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  redigirParaAuditoria: redactName,
  handler: async (input, ctx) => {
    const ready = await prepare(ctx);
    if ("ok" in ready) return ready;
    const opcao = decodeOpcao(ready.config, input.opcao_id);
    if (!opcao) return OPCAO_INVALIDA;
    if (opcao.r !== input.appointment_id) {
      return {
        ok: false,
        handoff: false,
        mensagem:
          "esse horário não foi buscado para este agendamento: chame mirae_free_slots com " +
          "remarcar_appointment_id e use o opcao_id que vier.",
      };
    }
    const body = {
      appointmentId: input.appointment_id,
      startsAt: opcao.t,
      professionalId: opcao.p,
      phone: ready.phone,
      name: input.nome_completo,
    };
    const key = miraeIdempotencyKey(ctx, "mirae_reschedule", body);
    if (!key) return NO_JOB;
    const moved = await write(
      () => rescheduleAppointment(ready.config, { ...body, idempotencyKey: key }),
      {
        ctx,
        ready,
        nameGiven: Boolean(input.nome_completo),
        appointmentId: input.appointment_id,
        verbo: "remarcar",
      },
    );
    if ("ok" in moved) return moved;
    return {
      ok: true,
      agendamento: bookedView(moved),
      aviso: "o appointment_id pode ter mudado: use o deste resultado daqui em diante.",
    };
  },
};

const cancelShape = {
  appointment_id: appointmentId("mirae_my_appointments"),
  nome_completo: nomeCompleto,
};

export const miraeCancel: McpToolDefinition<typeof cancelShape> = {
  name: "mirae_cancel",
  description:
    "Cancela a avaliação ou a aula da pessoa DESTA conversa na agenda do estúdio (Mirae). " +
    "Antes: ofereça remarcar; só cancele se ela preferir, e confirme com ela qual (dia e hora). " +
    "Use o appointment_id de mirae_my_appointments. Não peça nem registre o motivo.",
  inputSchema: cancelShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  redigirParaAuditoria: redactName,
  handler: async (input, ctx) => {
    const ready = await prepare(ctx);
    if ("ok" in ready) return ready;
    const body = {
      appointmentId: input.appointment_id,
      phone: ready.phone,
      name: input.nome_completo,
    };
    const key = miraeIdempotencyKey(ctx, "mirae_cancel", body);
    if (!key) return NO_JOB;
    const result = await write(
      () => cancelAppointment(ready.config, { ...body, idempotencyKey: key }),
      {
        ctx,
        ready,
        nameGiven: Boolean(input.nome_completo),
        appointmentId: input.appointment_id,
        verbo: "cancelar",
      },
    );
    if ("ok" in result) return result;
    return { ok: true, appointment_id: result.id, status: result.status };
  },
};
