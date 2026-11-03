/**
 * Berseba: a booking the server just wrote is proof for the promise reviewer.
 *
 * The semantic promise layer (`semantic.ts`) vetoes "confirming a slot without
 * proof". Its evidence only held catalog and knowledge snippets, so the
 * confirmation the agent sends right after `avec_book` ("Prontinho, seu horário
 * está marcado…") read as an invented slot. At the Mayara Morales salon the
 * reviewer vetoed one such confirmation five times in a row on 30/10: the visit
 * was in avec and the client was never told.
 *
 * Only a successful result of an avec write tool, as returned by its handler on
 * the server, becomes evidence. The model's arguments never do.
 */
import type { EvidenciaComercial } from "./evidencias-comerciais";

/** avec tools whose success means the visit is written in the salon's agenda. */
export const FERRAMENTAS_QUE_GRAVAM_NO_AVEC: ReadonlySet<string> = new Set([
  "avec_book",
  "avec_reschedule",
]);

function objeto(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function texto(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function evidenciaDoAgendamento(
  ferramenta: string,
  resultado: unknown,
): EvidenciaComercial | null {
  if (!FERRAMENTAS_QUE_GRAVAM_NO_AVEC.has(ferramenta)) return null;
  const r = objeto(resultado);
  if (!r || r.ok !== true) return null;
  const a = objeto(r.agendamento);
  if (!a) return null;
  const data = texto(a.data_br) ?? texto(a.data) ?? texto(a.date);
  const inicio = texto(a.inicio) ?? texto(a.start_time);
  if (!data || !inicio) return null;
  const servico = texto(a.servico) ?? texto(a.service);
  const profissional = texto(a.profissional) ?? texto(a.professional);
  return {
    origem: "agenda",
    referencia: `${ferramenta}:${data}:${inicio}`,
    titulo:
      ferramenta === "avec_reschedule"
        ? "Agendamento remarcado e gravado na agenda do salão neste atendimento"
        : "Agendamento gravado na agenda do salão neste atendimento",
    conteudo: JSON.stringify({
      situacao: "confirmado pelo sistema de agenda",
      ...(servico ? { servico } : {}),
      ...(texto(a.dia_semana) ?? texto(a.weekday)
        ? { dia_semana: texto(a.dia_semana) ?? texto(a.weekday) }
        : {}),
      data,
      inicio,
      ...(profissional ? { profissional } : {}),
    }),
  };
}
