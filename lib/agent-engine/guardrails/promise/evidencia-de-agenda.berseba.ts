/**
 * Berseba: what the salon's agenda just told the server is proof for the
 * promise reviewer.
 *
 * The semantic promise layer (`semantic.ts`) vetoes "confirming a slot without
 * proof". Its evidence only held catalog and knowledge snippets, so the
 * confirmation the agent sends right after `avec_book` ("Prontinho, seu horário
 * está marcado…") read as an invented slot. At the Mayara Morales salon the
 * reviewer vetoed one such confirmation five times in a row on 30/10: the visit
 * was in avec and the client was never told. The same holds for telling a client
 * the appointment she already has, read with `avec_my_appointments`.
 *
 * Only a successful result of an avec tool, as returned by its handler on the
 * server, becomes evidence. The model's arguments never do. The Mirae agenda
 * tools of Fiore Pilates follow the same rule (bottom of this file).
 */
import type { EvidenciaComercial } from "./evidencias-comerciais";

/** avec tools whose success says what is in the salon's agenda. */
export const FERRAMENTAS_DE_AGENDA_DO_AVEC: ReadonlySet<string> = new Set([
  "avec_book",
  "avec_reschedule",
  "avec_confirm",
  "avec_my_appointments",
  // Accepting a waitlist offer books the visit (`agendamento`, same shape as avec_book).
  "avec_waitlist",
]);

const TITULOS: Record<string, string> = {
  avec_waitlist: "Encaixe da lista de espera gravado e confirmado na agenda do salão neste atendimento",
  avec_book: "Agendamento gravado na agenda do salão neste atendimento",
  avec_reschedule: "Agendamento remarcado e gravado na agenda do salão neste atendimento",
  avec_confirm: "Presença confirmada na agenda do salão neste atendimento",
  avec_my_appointments: "Agendamento da cliente consultado na agenda do salão neste atendimento",
};

function objeto(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function texto(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** One visit, in either shape avec.ts returns (booking summary or appointment view). */
function evidenciaDaVisita(ferramenta: string, visita: unknown): EvidenciaComercial | null {
  const a = objeto(visita);
  if (!a) return null;
  const data = texto(a.data_br) ?? texto(a.data) ?? texto(a.date);
  const inicio = texto(a.inicio) ?? texto(a.start_time);
  if (!data || !inicio) return null;
  const servico = texto(a.servico) ?? texto(a.service);
  const profissional = texto(a.profissional) ?? texto(a.professional);
  const diaSemana = texto(a.dia_semana) ?? texto(a.weekday);
  const situacao = texto(a.status);
  return {
    origem: "agenda",
    // Two visits at the same hour (mother and daughter) are two pieces of evidence.
    referencia: [ferramenta, texto(a.appointment_id), data, inicio, servico, profissional]
      .filter(Boolean)
      .join(":"),
    titulo: TITULOS[ferramenta] ?? TITULOS.avec_book!,
    conteudo: JSON.stringify({
      fonte: "sistema de agenda do salão",
      ...(situacao ? { situacao } : {}),
      ...(servico ? { servico } : {}),
      ...(diaSemana ? { dia_semana: diaSemana } : {}),
      data,
      inicio,
      ...(profissional ? { profissional } : {}),
    }),
  };
}

export function evidenciasDaAgenda(ferramenta: string, resultado: unknown): EvidenciaComercial[] {
  if (FERRAMENTAS_DE_AGENDA_DO_MIRAE.has(ferramenta)) return evidenciasDoMirae(ferramenta, resultado);
  if (!FERRAMENTAS_DE_AGENDA_DO_AVEC.has(ferramenta)) return [];
  const r = objeto(resultado);
  if (!r || r.ok !== true) return [];
  // A confirmation answers the whole day, like the list does.
  const visitas =
    ferramenta === "avec_my_appointments" || ferramenta === "avec_confirm"
      ? r.agendamentos
      : [r.agendamento];
  if (!Array.isArray(visitas)) return [];
  return visitas
    .map((v) => evidenciaDaVisita(ferramenta, v))
    .filter((e): e is EvidenciaComercial => e !== null);
}

// ---------------------------------------------------------------------------
// Mirae (Fiore Pilates): the same rule over `lib/mcp/tools/mirae.ts`
// ---------------------------------------------------------------------------

/**
 * Mirae tools whose success the reviewer may read. Besides the booking (`mirae_book`,
 * `mirae_reschedule`) and the person's appointments (`mirae_my_appointments`), the studio's
 * agenda also answers what the agent OFFERS: the free slots (`mirae_free_slots`, availability,
 * never a booking) and the plans with prices and the booking rules (`mirae_services`). Without
 * them, "temos terça às 9h com a Raquel" or "o plano 2x por semana sai R$ 320 por mês" read as
 * invented. `mirae_cancel` says nothing worth proving.
 */
export const FERRAMENTAS_DE_AGENDA_DO_MIRAE: ReadonlySet<string> = new Set([
  "mirae_book",
  "mirae_reschedule",
  "mirae_my_appointments",
  "mirae_free_slots",
  "mirae_services",
]);

/** Every tool whose server answer becomes evidence (the wrap in `inbound-turn.ts` reads this). */
export const FERRAMENTAS_QUE_VIRAM_EVIDENCIA: ReadonlySet<string> = new Set([
  ...FERRAMENTAS_DE_AGENDA_DO_AVEC,
  ...FERRAMENTAS_DE_AGENDA_DO_MIRAE,
]);

const FONTE_DO_ESTUDIO = "agenda do estúdio (Mirae)";

const TITULOS_DO_MIRAE: Record<string, string> = {
  mirae_book: "Agendamento gravado na agenda do estúdio neste atendimento",
  mirae_reschedule: "Agendamento remarcado e gravado na agenda do estúdio neste atendimento",
  mirae_my_appointments: "Agendamento da pessoa consultado na agenda do estúdio neste atendimento",
  mirae_free_slots:
    "Horário livre consultado na agenda do estúdio neste atendimento (disponibilidade, ainda não reservado)",
};

/** One appointment or one free slot, as `mirae.ts` returns them. */
function evidenciaDoHorarioDoMirae(ferramenta: string, item: unknown): EvidenciaComercial | null {
  const a = objeto(item);
  if (!a) return null;
  const data = texto(a.data_br) ?? texto(a.data);
  const inicio = texto(a.inicio);
  if (!data || !inicio) return null;
  const servico = texto(a.servico);
  const profissional = texto(a.profissional);
  const diaSemana = texto(a.dia_semana);
  const termina = texto(a.termina);
  const livre = ferramenta === "mirae_free_slots";
  const situacao = livre ? "livre, ainda não reservado" : texto(a.status);
  const vagas = typeof a.vagas === "number" ? a.vagas : null;
  return {
    origem: "agenda",
    referencia: [ferramenta, texto(a.appointment_id), data, inicio, servico, profissional]
      .filter(Boolean)
      .join(":"),
    titulo: TITULOS_DO_MIRAE[ferramenta] ?? TITULOS_DO_MIRAE.mirae_book!,
    conteudo: JSON.stringify({
      fonte: FONTE_DO_ESTUDIO,
      ...(situacao ? { situacao } : {}),
      ...(servico ? { servico } : {}),
      ...(diaSemana ? { dia_semana: diaSemana } : {}),
      data,
      inicio,
      ...(termina ? { termina } : {}),
      ...(profissional ? { profissional } : {}),
      ...(vagas !== null ? { vagas } : {}),
    }),
  };
}

/** The plans and rules of `mirae_services`: prices are catalog, rules are policy. */
function evidenciasDosServicosDoMirae(r: Record<string, unknown>): EvidenciaComercial[] {
  const evidencias: EvidenciaComercial[] = [];
  for (const item of Array.isArray(r.planos) ? r.planos : []) {
    const p = objeto(item);
    const nome = p && texto(p.nome);
    const valor = p && texto(p.valor_br);
    if (!p || !nome || !valor) continue;
    const porMes = texto(p.por_mes_br);
    evidencias.push({
      origem: "catalogo",
      referencia: `mirae_services:${nome}`,
      titulo: `Plano ${nome} (valores liberados pelo estúdio)`,
      conteudo: JSON.stringify({
        fonte: FONTE_DO_ESTUDIO,
        nome,
        valor_total: valor,
        ...(typeof p.meses === "number" ? { meses: p.meses } : {}),
        ...(porMes ? { por_mes: porMes } : {}),
        ...(typeof p.aulas_por_semana === "number" ? { aulas_por_semana: p.aulas_por_semana } : {}),
      }),
    });
  }
  const regras = objeto(r.regras);
  if (regras) {
    evidencias.push({
      origem: "conhecimento",
      referencia: "mirae_services:regras",
      titulo: "Regras de agendamento do estúdio",
      conteudo: JSON.stringify({
        fonte: FONTE_DO_ESTUDIO,
        ...(Array.isArray(r.servicos) ? { servicos_marcados_pelo_agente: r.servicos } : {}),
        ...regras,
      }),
    });
  }
  return evidencias;
}

function evidenciasDoMirae(ferramenta: string, resultado: unknown): EvidenciaComercial[] {
  const r = objeto(resultado);
  if (!r || r.ok !== true) return [];
  if (ferramenta === "mirae_services") return evidenciasDosServicosDoMirae(r);
  const itens =
    ferramenta === "mirae_my_appointments"
      ? r.agendamentos
      : ferramenta === "mirae_free_slots"
        ? r.opcoes
        : [r.agendamento];
  if (!Array.isArray(itens)) return [];
  return itens
    .map((i) => evidenciaDoHorarioDoMirae(ferramenta, i))
    .filter((e): e is EvidenciaComercial => e !== null);
}
