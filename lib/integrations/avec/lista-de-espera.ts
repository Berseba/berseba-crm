/**
 * Berseba: the salon's waitlist over avec — who wants an earlier slot and which free slot serves her.
 *
 * Pure: no database, no clock (`agora` and `hoje` are parameters), no network. The storage and
 * the avec calls live in `lista-de-espera-supabase.ts`.
 *
 * ─── Why not upstream's `calendar_waitlist` as is ───────────────────────────
 *
 * Upstream's module (v1.104, `lib/agenda/lista-de-espera.ts`) is triggered by a cancelled
 * appointment of the CRM's own agenda and holds the slot as a pending CRM appointment. This
 * salon's agenda is avec: its CRM agenda has no appointments, so that trigger never fires. What
 * we keep from upstream is the policy and the organization's settings: one person at a time,
 * the offer deadline (`prazoDaOferta`, same `settings.lista_de_espera` keys), and "never offer
 * again the slot she refused".
 *
 * ─── An entry is a search the agent already knows how to run ────────────────
 *
 * The request is the same arguments `avec_free_slots` takes (service, hair length, professional,
 * days, time window), so a free slot is found by the same recipe code that books the visit with
 * its washing and drying steps. A cancellation done in avec, by Maya or by the team, shows up
 * the same way: as a visit option that did not exist before.
 */
import { z } from "zod";

import { prazoDaOferta, type ConfigDaListaDeEspera } from "@/lib/agenda/lista-de-espera";

import { COMPRIMENTOS, toMinutes, type Opcao } from "./ofertas";

const FUSO = "America/Sao_Paulo";
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;

/** How far ahead an entry may ask: the salon's agenda opens about three months ahead. */
export const MAX_DIAS_A_FRENTE = 120;

/** The request of an entry. Same vocabulary as `avec_free_slots`. */
export const pedidoDaEsperaSchema = z.strictObject({
  /** `servico` of `avec_find_services`. */
  servico: z.string().trim().min(1).max(40),
  comprimento: z.enum(COMPRIMENTOS).nullable().default(null),
  /** avec professional id; `null` = whoever does the service. */
  profissional: z.string().trim().min(1).max(60).nullable().default(null),
});
export type PedidoDaEspera = z.infer<typeof pedidoDaEsperaSchema>;

export const horaSchema = z.string().regex(HHMM, "use HH:MM");
export const dataSchema = z.string().regex(DATA, "use AAAA-MM-DD");

/** One entry, in the vocabulary of the decision. */
export interface InscricaoAvec {
  id: string;
  contactId: string;
  pedido: PedidoDaEspera;
  /** First and last day she can come (`YYYY-MM-DD`, Brasília). */
  dataDe: string;
  dataAte: string;
  /** Earliest and latest START time (`HH:MM`); `null` = any. */
  depoisDe: string | null;
  ate: string | null;
  /** The day of the visit she already has and wants to move earlier; `null` = no visit yet. */
  substituiData: string | null;
  /** Smaller first. The team reorders by swapping it. */
  ordem: number;
  createdAt: Date;
  /** `chaveDaVaga` of the slots she refused or let expire. */
  recusadas: readonly string[];
}

/** Who is busy and when, on one day: the principal and the helper of a visit. */
export interface Ocupacao {
  profissional: string;
  data: string;
  inicio: number;
  fim: number;
}

/** The identity of an offered slot: day, start and professional. */
export function chaveDaVaga(o: Pick<Opcao, "data" | "inicio" | "profissional">): string {
  return `${o.data}|${o.inicio}|${o.profissional}`;
}

/**
 * The people a visit occupies. The helper is counted for the whole visit: it hides a little more
 * than the exact washing and drying steps, which is the safe side of a hold.
 */
export function ocupacaoDa(o: Opcao): Ocupacao[] {
  const intervalo = { data: o.data, inicio: toMinutes(o.inicio), fim: toMinutes(o.fim) };
  const pessoas = o.auxiliar && o.auxiliar !== o.profissional ? [o.profissional, o.auxiliar] : [o.profissional];
  return pessoas.map((profissional) => ({ profissional, ...intervalo }));
}

export function sobrepoe(a: readonly Ocupacao[], b: readonly Ocupacao[]): boolean {
  return a.some((x) =>
    b.some((y) => x.profissional === y.profissional && x.data === y.data && x.inicio < y.fim && y.inicio < x.fim),
  );
}

/** The instant a visit option starts. Brasília has had no daylight saving time since 2019. */
export function inicioDaOpcao(o: Pick<Opcao, "data" | "inicio">): Date {
  return new Date(`${o.data}T${o.inicio}:00-03:00`);
}

/** Today in Brasília, `YYYY-MM-DD`. */
export function hojeNoSalao(agora: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FUSO }).format(agora);
}

export function somarDias(data: string, dias: number): string {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** The days to search for an entry today, or `null` when nothing of it is left ahead. */
export function janelaDeBusca(
  inscricao: Pick<InscricaoAvec, "dataDe" | "dataAte" | "substituiData">,
  hoje: string,
  maxDias = 14,
): { de: string; ate: string } | null {
  const de = inscricao.dataDe > hoje ? inscricao.dataDe : hoje;
  let ate = inscricao.dataAte;
  // Moving a visit earlier: only days before it are worth offering.
  if (inscricao.substituiData && inscricao.substituiData <= ate) ate = somarDias(inscricao.substituiData, -1);
  const teto = somarDias(de, maxDias - 1);
  if (ate > teto) ate = teto;
  return de <= ate ? { de, ate } : null;
}

export type MotivoSemVaga =
  | "fora_das_datas"
  | "fora_do_horario"
  | "ja_recusada"
  | "segurada_para_outra"
  | "perto_demais";

/** Why a visit option does not serve this entry, or `null` when it does. */
export function motivoParaNaoServir(
  inscricao: InscricaoAvec,
  opcao: Opcao,
  seguradas: readonly Ocupacao[],
  agora: Date,
  config: ConfigDaListaDeEspera,
): MotivoSemVaga | null {
  const janela = janelaDeBusca(inscricao, hojeNoSalao(agora), MAX_DIAS_A_FRENTE);
  if (!janela || opcao.data < janela.de || opcao.data > janela.ate) return "fora_das_datas";
  const inicio = toMinutes(opcao.inicio);
  if (inscricao.depoisDe && inicio < toMinutes(inscricao.depoisDe)) return "fora_do_horario";
  if (inscricao.ate && inicio > toMinutes(inscricao.ate)) return "fora_do_horario";
  if (inscricao.recusadas.includes(chaveDaVaga(opcao))) return "ja_recusada";
  if (sobrepoe(ocupacaoDa(opcao), seguradas)) return "segurada_para_outra";
  if (!prazoDaOfertaAvec(opcao, agora, config)) return "perto_demais";
  return null;
}

/** The slot to offer this entry: the earliest option that serves her, or `null`. */
export function vagaParaInscricao(
  inscricao: InscricaoAvec,
  opcoes: readonly Opcao[],
  seguradas: readonly Ocupacao[],
  agora: Date,
  config: ConfigDaListaDeEspera,
): Opcao | null {
  const servem = opcoes.filter((o) => motivoParaNaoServir(inscricao, o, seguradas, agora, config) === null);
  servem.sort((a, b) => a.data.localeCompare(b.data) || a.inicio.localeCompare(b.inicio));
  return servem[0] ?? null;
}

/** The queue in calling order: the team's order, then arrival, then id (deterministic). */
export function ordenarFilaAvec<T extends Pick<InscricaoAvec, "ordem" | "createdAt" | "id">>(fila: readonly T[]): T[] {
  return [...fila].sort(
    (a, b) => a.ordem - b.ordem || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
}

/** Until when the slot is held for her, by the organization's settings (upstream's rule). */
export function prazoDaOfertaAvec(
  opcao: Pick<Opcao, "data" | "inicio">,
  agora: Date,
  config: ConfigDaListaDeEspera,
): Date | null {
  const startsAt = inicioDaOpcao(opcao);
  return prazoDaOferta(
    { appointmentId: "avec", startsAt, endsAt: startsAt, ownerUserId: null, timeZone: FUSO },
    agora,
    config,
  );
}

const DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** `sábado, 20/12, às 15h` / `às 15h30`. */
export function quandoPorExtenso(o: Pick<Opcao, "data" | "inicio">): string {
  const dia = DIAS[new Date(`${o.data}T12:00:00Z`).getUTCDay()]!;
  const [h, m] = o.inicio.split(":");
  return `${dia}, ${o.data.slice(8, 10)}/${o.data.slice(5, 7)}, às ${Number(h)}h${m === "00" ? "" : m}`;
}

/** `17h` / `17h30`, in Brasília. */
export function horaPorExtenso(instante: Date): string {
  // Brasília is UTC-3 all year (no daylight saving time since 2019), as in `inicioDaOpcao`.
  const local = new Date(instante.getTime() - 3 * 3_600_000);
  const m = local.getUTCMinutes();
  return `${local.getUTCHours()}h${m === 0 ? "" : String(m).padStart(2, "0")}`;
}

/** The WhatsApp text of an offer. Portuguese: the client reads it. */
export function textoDaOfertaAvec(entrada: {
  nome: string | null;
  servico: string;
  profissional: string | null;
  opcao: Pick<Opcao, "data" | "inicio">;
  expiraEm: Date;
  substituiData: string | null;
}): string {
  const primeiro = entrada.nome?.trim().split(/\s+/)[0];
  // Built in pieces: a template starting with the greeting would read, to the course's lesson
  // fence, as the start of every lesson text that opens with the same word.
  const oi = ["Oi", primeiro].filter(Boolean).join(", ") + "! ";
  const com = entrada.profissional ? ` com ${entrada.profissional}` : "";
  const troca = entrada.substituiData
    ? ` Se quiser, eu troco pelo seu horário do dia ${entrada.substituiData.slice(8, 10)}/${entrada.substituiData.slice(5, 7)}.`
    : "";
  return (
    `${oi}Abriu um horário da lista de espera: ${quandoPorExtenso(entrada.opcao)}, ${entrada.servico}${com}.` +
    `${troca} É seu se quiser! Me responde SIM até as ${horaPorExtenso(entrada.expiraEm)} que eu já deixo ` +
    `marcado e confirmado. Depois disso ele vai para a próxima pessoa da lista.`
  );
}
