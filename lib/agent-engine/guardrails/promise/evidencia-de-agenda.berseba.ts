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
 * server, becomes evidence. The model's arguments never do.
 */
import type { EvidenciaComercial } from "./evidencias-comerciais";

/** avec tools whose success says what is in the salon's agenda. */
export const FERRAMENTAS_DE_AGENDA_DO_AVEC: ReadonlySet<string> = new Set([
  "avec_book",
  "avec_reschedule",
  "avec_my_appointments",
]);

const TITULOS: Record<string, string> = {
  avec_book: "Agendamento gravado na agenda do salão neste atendimento",
  avec_reschedule: "Agendamento remarcado e gravado na agenda do salão neste atendimento",
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
  if (!FERRAMENTAS_DE_AGENDA_DO_AVEC.has(ferramenta)) return [];
  const r = objeto(resultado);
  if (!r || r.ok !== true) return [];
  const visitas = ferramenta === "avec_my_appointments" ? r.agendamentos : [r.agendamento];
  if (!Array.isArray(visitas)) return [];
  return visitas
    .map((v) => evidenciaDaVisita(ferramenta, v))
    .filter((e): e is EvidenciaComercial => e !== null);
}
