/**
 * Berseba: what the agent may book in avec by itself, and how ("ofertas").
 *
 * avec links almost every professional to almost every service, so its catalog cannot say who
 * really does what. Each salon declares here the services the agent books alone, who does each
 * one, and the "receita" of the visit: the bookings avec needs and their offsets. The recipes
 * come from the salon's real agenda (30 days read on 2026-10-23, aggregates only), approved by
 * Matheus. Anything not listed (mechas, noiva, maquiagem, …) is the team's.
 *
 * Pure module: no I/O. The tools in `lib/mcp/tools/avec.ts` fetch availability and call it.
 * When the integrations registry lands, a salon's ofertas move to its configuration.
 */
import type { AvecSlot } from "./client";

export type Comprimento = "curto" | "medio" | "longo" | "extra_longo";
export const COMPRIMENTOS: readonly Comprimento[] = ["curto", "medio", "longo", "extra_longo"];

/** A service id, or one per hair length (a missing length = the team decides). */
type ServicoRef = string | Partial<Record<Comprimento, string>>;

interface Etapa {
  servico: ServicoRef;
  /** Minutes after the start of the visit, or one per hair length. Always a multiple of 30. */
  inicio: number | Partial<Record<Comprimento, number>>;
  /** `principal` = the professional the client chose; `auxiliar` = one helper for all such steps. */
  papel: "principal" | "auxiliar";
}

interface Oferta {
  id: string;
  rotulo: string;
  /** What the agent must know before searching, besides day and time. */
  perguntar?: string;
  comprimento: boolean;
  porProfissional: Array<{ profissional: string; etapas: Etapa[] }>;
}

interface Profissional {
  id: string;
  nome: string;
}

export interface Salao {
  profissionais: Record<string, Profissional>;
  /** Helpers for `auxiliar` steps, in the order the salon uses them most. */
  auxiliares: string[];
  /** How the agent names a helper's step to the client ("secagem às 14h30 com a Júlia"). */
  nomeDaEtapa: Record<string, string>;
  ofertas: Oferta[];
  /** Services the team keeps, told to the agent so it hands off without searching. */
  comAEquipe: string[];
}

// ---------------------------------------------------------------------------
// Mayara Morales Cabeleireiros (Bauru)
// ---------------------------------------------------------------------------

const MAYARA = "430008";
const ELITON = "447143";
const REBECA = "447142";
const SIMONE = "444099";
const GIOVANNA = "444096";
const JUNIOR = "444091";
const SUELLEN = "444090";
const JULIA = "797917";

const SECAGEM = { curto: "2129311", medio: "2129312", longo: "2129313", extra_longo: "2129314" };
const LAVAGEM_PARA_CORTE = "2128749";

// Tintura, tonalizante and hidratação: everyone but Júlia (Matheus, 2026-10-23). The list stays
// with the four who did them in the agenda until Johnny confirms (Eliton, Suellen?).
const COR = [MAYARA, GIOVANNA, JUNIOR, SIMONE];

// Nutrição and reconstrução: everyone but Mayara Morales (Matheus, 2026-10-23); the ones who did
// them in the agenda until Johnny confirms Eliton and Suellen.
const TRATAMENTO = [SIMONE, GIOVANNA, JUNIOR, JULIA];

const so = (servico: ServicoRef): Etapa[] => [{ servico, inicio: 0, papel: "principal" }];
/** Every corte has its wash, by a helper at the same time (Matheus, 2026-10-23). */
const comLavagem = (servico: string): Etapa[] => [
  { servico, inicio: 0, papel: "principal" },
  { servico: LAVAGEM_PARA_CORTE, inicio: 0, papel: "auxiliar" },
];
const cada = (profissionais: string[], etapas: Etapa[]) =>
  profissionais.map((profissional) => ({ profissional, etapas }));

const SALAO_MAYARA: Salao = {
  profissionais: {
    [MAYARA]: { id: MAYARA, nome: "Mayara Morales" },
    [ELITON]: { id: ELITON, nome: "Eliton" },
    [REBECA]: { id: REBECA, nome: "Rebeca" },
    [SIMONE]: { id: SIMONE, nome: "Simone" },
    [GIOVANNA]: { id: GIOVANNA, nome: "Giovanna" },
    [JUNIOR]: { id: JUNIOR, nome: "Júnior" },
    [SUELLEN]: { id: SUELLEN, nome: "Suellen" },
    [JULIA]: { id: JULIA, nome: "Júlia" },
  },
  auxiliares: [JULIA, JUNIOR, SIMONE, GIOVANNA, SUELLEN],
  nomeDaEtapa: {
    [LAVAGEM_PARA_CORTE]: "lavagem",
    ...Object.fromEntries(Object.values(SECAGEM).map((id) => [id, "secagem"])),
  },
  ofertas: [
    {
      id: "corte_feminino",
      rotulo: "Corte feminino, sem secagem (inclui a lavagem)",
      perguntar: "se quer finalizar com secagem e se tem preferência de profissional",
      comprimento: false,
      porProfissional: [
        {
          profissional: MAYARA,
          etapas: [
            { servico: "2128712", inicio: 0, papel: "principal" },
            { servico: LAVAGEM_PARA_CORTE, inicio: 0, papel: "auxiliar" },
          ],
        },
        { profissional: ELITON, etapas: comLavagem("3238931") },
      ],
    },
    {
      id: "corte_feminino_com_secagem",
      rotulo: "Corte feminino com secagem (lavagem, corte e secagem)",
      perguntar: "o comprimento do cabelo e se tem preferência de profissional",
      comprimento: true,
      porProfissional: [
        {
          profissional: MAYARA,
          etapas: [
            { servico: "2128712", inicio: 0, papel: "principal" },
            { servico: LAVAGEM_PARA_CORTE, inicio: 0, papel: "auxiliar" },
            { servico: SECAGEM, inicio: 30, papel: "auxiliar" },
          ],
        },
        {
          // Eliton dries his own client (agenda); the wash is a helper's, as for every corte.
          profissional: ELITON,
          etapas: [
            { servico: "3238931", inicio: 0, papel: "principal" },
            { servico: LAVAGEM_PARA_CORTE, inicio: 0, papel: "auxiliar" },
            { servico: SECAGEM, inicio: 30, papel: "principal" },
          ],
        },
      ],
    },
    {
      // Never with secagem (Matheus, 2026-10-23): the agent does not even ask.
      id: "corte_masculino",
      rotulo: "Corte masculino (inclui a lavagem)",
      comprimento: false,
      porProfissional: [
        { profissional: MAYARA, etapas: comLavagem("2128714") },
        { profissional: ELITON, etapas: comLavagem("3238946") },
      ],
    },
    {
      id: "corte_infantil",
      rotulo: "Corte infantil, sem secagem (inclui a lavagem)",
      perguntar: "se quer finalizar com secagem e se tem preferência de profissional",
      comprimento: false,
      porProfissional: [
        { profissional: MAYARA, etapas: comLavagem("2128713") },
        { profissional: ELITON, etapas: comLavagem("3238948") },
      ],
    },
    {
      id: "corte_infantil_com_secagem",
      rotulo: "Corte infantil com secagem (lavagem, corte e secagem)",
      perguntar: "o comprimento do cabelo e se tem preferência de profissional",
      comprimento: true,
      porProfissional: [
        {
          profissional: MAYARA,
          etapas: [
            { servico: "2128713", inicio: 0, papel: "principal" },
            { servico: LAVAGEM_PARA_CORTE, inicio: 0, papel: "auxiliar" },
            { servico: SECAGEM, inicio: 30, papel: "auxiliar" },
          ],
        },
        {
          profissional: ELITON,
          etapas: [
            { servico: "3238948", inicio: 0, papel: "principal" },
            { servico: LAVAGEM_PARA_CORTE, inicio: 0, papel: "auxiliar" },
            { servico: SECAGEM, inicio: 30, papel: "principal" },
          ],
        },
      ],
    },
    {
      id: "sobrancelha_design",
      rotulo: "Design de sobrancelha (só o design)",
      comprimento: false,
      porProfissional: [{ profissional: REBECA, etapas: so("2129417") }],
    },
    {
      id: "sobrancelha_com_henna",
      rotulo: "Design de sobrancelha com henna",
      comprimento: false,
      porProfissional: [
        {
          profissional: REBECA,
          etapas: [
            { servico: "2129417", inicio: 0, papel: "principal" },
            { servico: "2129318", inicio: 30, papel: "principal" },
          ],
        },
      ],
    },
    {
      id: "sobrancelha_com_tintura",
      rotulo: "Design de sobrancelha com tintura",
      comprimento: false,
      porProfissional: [
        {
          profissional: REBECA,
          etapas: [
            { servico: "2129417", inicio: 0, papel: "principal" },
            { servico: "2129442", inicio: 30, papel: "principal" },
          ],
        },
      ],
    },
    {
      id: "tintura_raiz",
      rotulo: "Tintura de raiz (retoque de raiz ou cobertura de branco), com secagem",
      perguntar: "o comprimento do cabelo e se tem preferência de profissional",
      comprimento: true,
      // Application 30 min, the dye acts 1 h, then the drying: +90 in 152 visits of the agenda.
      porProfissional: cada(COR, [
        { servico: "2181246", inicio: 0, papel: "principal" },
        { servico: SECAGEM, inicio: 90, papel: "auxiliar" },
      ]),
    },
    {
      id: "tonalizante",
      rotulo: "Tonalizante (cabelo todo), com secagem",
      perguntar: "o comprimento do cabelo e se tem preferência de profissional",
      comprimento: true,
      // The drying starts 1 h after the toner ends (Matheus): toners take 30 min up to medium
      // length and 60 min from long, so +90 or +120.
      porProfissional: cada(COR, [
        {
          servico: { curto: "2181291", medio: "2181298", longo: "2181308", extra_longo: "2181315" },
          inicio: 0,
          papel: "principal",
        },
        {
          servico: SECAGEM,
          inicio: { curto: 90, medio: 90, longo: 120, extra_longo: 120 },
          papel: "auxiliar",
        },
      ]),
    },
    {
      id: "tonalizante_raiz",
      rotulo: "Tonalizante só na raiz, com secagem",
      perguntar: "o comprimento do cabelo (para a secagem) e se tem preferência de profissional",
      comprimento: true,
      porProfissional: cada(COR, [
        { servico: "2181285", inicio: 0, papel: "principal" },
        { servico: SECAGEM, inicio: 90, papel: "auxiliar" },
      ]),
    },
    {
      id: "escova",
      rotulo: "Escova",
      perguntar: "o comprimento do cabelo",
      comprimento: true,
      porProfissional: cada(
        [SIMONE, GIOVANNA, JUNIOR, SUELLEN],
        so({ curto: "2128720", medio: "2128719", longo: "2128718", extra_longo: "2128734" }),
      ),
    },
    {
      id: "hidratacao",
      rotulo: "Hidratação capilar",
      perguntar: "o comprimento do cabelo",
      comprimento: true,
      porProfissional: cada(
        COR,
        so({ curto: "2128740", medio: "2128743", longo: "2129363", extra_longo: "2129366" }),
      ),
    },
    {
      id: "nutricao",
      rotulo: "Nutrição capilar",
      perguntar: "o comprimento do cabelo",
      comprimento: true,
      porProfissional: cada(
        TRATAMENTO,
        so({ curto: "2153527", medio: "2153526", longo: "2128717", extra_longo: "3239159" }),
      ),
    },
    {
      id: "reconstrucao",
      rotulo: "Reconstrução capilar",
      perguntar: "o comprimento do cabelo",
      comprimento: true,
      porProfissional: cada(
        TRATAMENTO,
        so({ curto: "2129187", medio: "2153545", longo: "2129179" }),
      ),
    },
    {
      id: "progressiva",
      rotulo: "Progressiva (cabelo todo)",
      perguntar: "o comprimento do cabelo",
      comprimento: true,
      porProfissional: cada(
        [JUNIOR],
        so({ curto: "2129167", medio: "2128737", longo: "2129174", extra_longo: "2129168" }),
      ),
    },
    {
      id: "progressiva_raiz",
      rotulo: "Progressiva só na raiz (retoque)",
      comprimento: false,
      porProfissional: cada([JUNIOR], so("2128739")),
    },
    {
      id: "selamento",
      rotulo: "Selamento (cabelo todo)",
      perguntar: "o comprimento do cabelo",
      comprimento: true,
      porProfissional: cada(
        [JUNIOR],
        so({ curto: "2129367", medio: "2229692", longo: "2229702", extra_longo: "2129401" }),
      ),
    },
    {
      id: "selamento_raiz",
      rotulo: "Selamento só na raiz (retoque)",
      comprimento: false,
      porProfissional: cada([JUNIOR], so("2310921")),
    },
  ],
  comAEquipe: [
    "mechas",
    "morena iluminada",
    "luzes",
    "teste de mechas",
    "avaliação",
    "tintura no cabelo todo, mudança de cor, coloração em cabelo com química",
    "dois serviços diferentes na mesma visita (ex.: corte + tintura)",
    "noiva, casamento, debutante",
    "penteado",
    "maquiagem",
    "massagem, tratamento facial, visagismo",
    "alongamento",
    "corte de franja, progressiva/selamento de franja ou arco",
  ],
};

const MAYARA_ORG = "e054ee97-00a7-42fd-9701-279afc04a74c";

const SALOES: Record<string, Salao> = { [MAYARA_ORG]: SALAO_MAYARA };

/** The salon of this organization, or `null` when it books nothing by itself. */
export function salaoDa(organizationId: string): Salao | null {
  return SALOES[organizationId.toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// recipe resolution
// ---------------------------------------------------------------------------

function servicoDe(ref: ServicoRef, comprimento: Comprimento | null): string | null {
  if (typeof ref === "string") return ref;
  return comprimento ? (ref[comprimento] ?? null) : null;
}

interface EtapaResolvida {
  servico: string;
  inicio: number;
  papel: "principal" | "auxiliar";
}

/** The steps of an oferta for one professional and length, or `null` when a length is missing. */
export function etapasDe(
  oferta: Oferta,
  profissional: string,
  comprimento: Comprimento | null,
): EtapaResolvida[] | null {
  const entry = oferta.porProfissional.find((p) => p.profissional === profissional);
  if (!entry) return null;
  const out: EtapaResolvida[] = [];
  for (const etapa of entry.etapas) {
    const servico = servicoDe(etapa.servico, comprimento);
    const inicio =
      typeof etapa.inicio === "number"
        ? etapa.inicio
        : comprimento
          ? etapa.inicio[comprimento]
          : null;
    if (!servico || inicio === null || inicio === undefined) return null;
    out.push({ servico, inicio, papel: etapa.papel });
  }
  return out;
}

export function ofertaPorId(salao: Salao, id: string): Oferta | null {
  return salao.ofertas.find((o) => o.id === id) ?? null;
}

/** Every service id the agent may cancel or reschedule alone: the step 0 of a one-step oferta. */
export function servicosAvulsos(salao: Salao): Set<string> {
  const ids = new Set<string>();
  for (const oferta of salao.ofertas) {
    for (const { etapas } of oferta.porProfissional) {
      if (etapas.length !== 1) continue;
      const ref = etapas[0]!.servico;
      for (const id of typeof ref === "string" ? [ref] : Object.values(ref)) ids.add(id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// slots → visit options
// ---------------------------------------------------------------------------

export const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** What one availability call needs: a service, and the professional when there is only one. */
export interface Consulta {
  servico: string;
  profissional?: string;
}

/** The availability calls a search needs, one per service. */
export function consultasPara(
  salao: Salao,
  oferta: Oferta,
  principais: string[],
  comprimento: Comprimento | null,
  auxiliares: string[] = salao.auxiliares,
): Consulta[] {
  const porServico = new Map<string, Set<string>>();
  const add = (servico: string, prof: string) =>
    porServico.set(servico, (porServico.get(servico) ?? new Set()).add(prof));
  for (const prof of principais) {
    for (const etapa of etapasDe(oferta, prof, comprimento) ?? []) {
      if (etapa.papel === "principal") add(etapa.servico, prof);
      else for (const aux of auxiliares) add(etapa.servico, aux);
    }
  }
  return [...porServico].map(([servico, profs]) =>
    profs.size === 1 ? { servico, profissional: [...profs][0] } : { servico },
  );
}

export interface Opcao {
  opcao_id: string;
  data: string;
  inicio: string;
  fim: string;
  profissional: string;
  auxiliar?: string;
  /** The helper's steps, so the client hears them: `[{servico: "secagem", inicio: "14:30"}]`. */
  etapasDaAuxiliar?: Array<{ servico: string; inicio: string }>;
  /** 0 = next to a booking of the professional; 1 = she has clients that day; 2 = empty day. */
  agrupamento: 0 | 1 | 2;
}

const slotKey = (prof: string, servico: string, data: string, inicio: number) =>
  `${prof}|${servico}|${data}|${inicio}`;

/** `ofertaId:comprimento:slot+slot+…`. The slot ids carry professional, service, day and time. */
export function codificarOpcao(
  ofertaId: string,
  comprimento: Comprimento | null,
  slotIds: string[],
): string {
  return `${ofertaId}:${comprimento ?? "-"}:${slotIds.join("+")}`;
}

/** Every visit the slots allow: one per start of the principal's first step that fits. */
export function montarOpcoes(
  salao: Salao,
  oferta: Oferta,
  principais: string[],
  comprimento: Comprimento | null,
  slots: AvecSlot[],
  auxiliares: string[] = salao.auxiliares,
): Opcao[] {
  const livres = new Map<string, AvecSlot>();
  for (const s of slots) {
    livres.set(slotKey(s.professional_id, s.service_id, s.date, toMinutes(s.start_time)), s);
  }
  const opcoes: Opcao[] = [];
  for (const prof of principais) {
    const etapas = etapasDe(oferta, prof, comprimento);
    if (!etapas || etapas[0]!.papel !== "principal" || etapas[0]!.inicio !== 0) continue;
    const primeiras = slots.filter(
      (s) => s.professional_id === prof && s.service_id === etapas[0]!.servico,
    );
    for (const first of primeiras) {
      const t0 = toMinutes(first.start_time);
      const doPrincipal: AvecSlot[] = [];
      let ok = true;
      for (const etapa of etapas.filter((e) => e.papel === "principal")) {
        const s = livres.get(slotKey(prof, etapa.servico, first.date, t0 + etapa.inicio));
        if (!s) {
          ok = false;
          break;
        }
        doPrincipal.push(s);
      }
      if (!ok) continue;
      const deAux = etapas.filter((e) => e.papel === "auxiliar");
      let auxiliar: string | undefined;
      if (deAux.length > 0) {
        // The colourist dries her own client when she can; a helper the client asked for only.
        const candidatas = auxiliares.includes(prof)
          ? [prof, ...auxiliares.filter((a) => a !== prof)]
          : auxiliares;
        for (const aux of candidatas) {
          const achados = deAux.map((e) =>
            livres.get(slotKey(aux, e.servico, first.date, t0 + e.inicio)),
          );
          if (achados.some((s) => !s)) continue;
          const found = achados as AvecSlot[];
          // The same person cannot be in two places: skip a helper who overlaps her own steps.
          const overlaps =
            aux === prof &&
            found.some((a) =>
              doPrincipal.some(
                (p) =>
                  toMinutes(a.start_time) < toMinutes(p.end_time) &&
                  toMinutes(p.start_time) < toMinutes(a.end_time),
              ),
            );
          if (overlaps) continue;
          auxiliar = aux;
          break;
        }
        if (!auxiliar) continue;
      }
      // Slot ids in the order of the recipe, so booking follows it.
      const ordered = etapas.map((e) => {
        const quem = e.papel === "principal" ? prof : auxiliar!;
        return livres.get(slotKey(quem, e.servico, first.date, t0 + e.inicio))!;
      });
      const last = doPrincipal[doPrincipal.length - 1]!;
      const before = first.gap_before_minutes;
      const after = last.gap_after_minutes;
      const colado =
        (before !== null && before !== undefined && before <= 30) ||
        (after !== null && after !== undefined && after <= 30);
      const agrupamento = colado ? 0 : (first.bookings_that_day ?? 0) > 0 ? 1 : 2;
      opcoes.push({
        opcao_id: codificarOpcao(
          oferta.id,
          comprimento,
          ordered.map((s) => s.id),
        ),
        data: first.date,
        inicio: first.start_time,
        fim: toHhmm(Math.max(...ordered.map((s) => toMinutes(s.end_time)))),
        profissional: prof,
        ...(auxiliar
          ? {
              auxiliar,
              etapasDaAuxiliar: deAux.map((e) => ({
                servico: salao.nomeDaEtapa[e.servico] ?? "etapa",
                inicio: toHhmm(t0 + e.inicio),
              })),
            }
          : {}),
        agrupamento,
      });
    }
  }
  return opcoes;
}

export type DiaSemana = "terca" | "quarta" | "quinta" | "sexta" | "sabado";
const DIA_SEMANA_UTC: Record<DiaSemana, number> = {
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
};

export interface Preferencia {
  data?: string;
  dias_semana?: DiaSemana[];
  periodo?: "manha" | "tarde";
  horario?: string;
}

export const MAX_OPCOES = 3;
const MAX_POR_DIA = 2;

/**
 * The 2–3 options to offer, the salon's convention first:
 *  1. what the client asked (day, weekday, period; the closest to the time she said);
 *  2. next to a client the professional already has that day (≤ 30 min), then a day she
 *     already works with clients; an empty day only when the client asked for that day;
 *  3. this week before next week, then the earliest; at most 2 options on the same day.
 */
export function escolherOpcoes(opcoes: Opcao[], pref: Preferencia, hoje: string): Opcao[] {
  const pediuDia = Boolean(pref.data || pref.dias_semana?.length);
  const dias = new Set((pref.dias_semana ?? []).map((d) => DIA_SEMANA_UTC[d]));
  const alvo = pref.horario ? toMinutes(pref.horario) : null;
  const base = Date.parse(`${hoje}T12:00:00Z`);
  const semana = (data: string) =>
    Date.parse(`${data}T12:00:00Z`) - base >= 7 * 86_400_000 ? 1 : 0;

  const filtradas = opcoes.filter((o) => {
    if (pref.data && o.data !== pref.data) return false;
    if (dias.size && !dias.has(new Date(`${o.data}T12:00:00Z`).getUTCDay())) return false;
    const inicio = toMinutes(o.inicio);
    if (pref.periodo === "manha" && inicio >= 12 * 60) return false;
    if (pref.periodo === "tarde" && inicio < 12 * 60) return false;
    return pediuDia || o.agrupamento < 2;
  });
  const ordenadas = [...filtradas].sort((a, b) => {
    if (alvo !== null) {
      const d = Math.abs(toMinutes(a.inicio) - alvo) - Math.abs(toMinutes(b.inicio) - alvo);
      if (d !== 0) return d;
    }
    return (
      semana(a.data) - semana(b.data) ||
      a.agrupamento - b.agrupamento ||
      a.data.localeCompare(b.data) ||
      a.inicio.localeCompare(b.inicio)
    );
  });
  const escolhidas: Opcao[] = [];
  const porDia = new Map<string, number>();
  for (const o of ordenadas) {
    if ((porDia.get(o.data) ?? 0) >= MAX_POR_DIA) continue;
    // Two options at the same time on the same day only differ by professional: keep one.
    if (escolhidas.some((e) => e.data === o.data && e.inicio === o.inicio)) continue;
    escolhidas.push(o);
    porDia.set(o.data, (porDia.get(o.data) ?? 0) + 1);
    if (escolhidas.length === MAX_OPCOES) break;
  }
  return escolhidas;
}

// ---------------------------------------------------------------------------
// option id → the bookings to make, checked against the recipe
// ---------------------------------------------------------------------------

const SLOT_ID = /^([^-]+)-([^-]+)-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})$/;

export interface SlotDaOpcao {
  slotId: string;
  profissional: string;
  servico: string;
  data: string;
  inicio: number;
  papel: "principal" | "auxiliar";
}

export interface OpcaoValida {
  oferta: Oferta;
  comprimento: Comprimento | null;
  principal: string;
  auxiliar?: string;
  slots: SlotDaOpcao[];
}

/**
 * Decode an `opcao_id` and check it is exactly a recipe of this salon: the oferta exists, every
 * slot is the recipe's service, at its offset, on the same day, by the principal or by ONE
 * helper of the salon. The model cannot assemble a visit the salon did not declare.
 */
export function validarOpcao(salao: Salao, opcaoId: string): OpcaoValida | null {
  const [ofertaId, comp, joined, ...rest] = opcaoId.split(":");
  if (!ofertaId || !comp || !joined || rest.length) return null;
  const oferta = ofertaPorId(salao, ofertaId);
  if (!oferta) return null;
  const comprimento = comp === "-" ? null : (comp as Comprimento);
  if (comprimento !== null && !COMPRIMENTOS.includes(comprimento)) return null;
  if (oferta.comprimento !== (comprimento !== null)) return null;
  const parsed = joined.split("+").map((id) => {
    const m = SLOT_ID.exec(id);
    return m
      ? {
          slotId: id,
          profissional: m[1]!,
          servico: m[2]!,
          data: m[3]!,
          inicio: Number(m[4]) * 60 + Number(m[5]),
        }
      : null;
  });
  if (parsed.some((p) => !p)) return null;
  const slots = parsed as Omit<SlotDaOpcao, "papel">[];
  const principal = slots[0]!.profissional;
  const etapas = etapasDe(oferta, principal, comprimento);
  if (!etapas || etapas.length !== slots.length) return null;
  const t0 = slots[0]!.inicio;
  let auxiliar: string | undefined;
  const out: SlotDaOpcao[] = [];
  for (let i = 0; i < etapas.length; i++) {
    const etapa = etapas[i]!;
    const slot = slots[i]!;
    if (slot.servico !== etapa.servico) return null;
    if (slot.data !== slots[0]!.data || slot.inicio !== t0 + etapa.inicio) return null;
    if (etapa.papel === "principal") {
      if (slot.profissional !== principal) return null;
    } else {
      if (!salao.auxiliares.includes(slot.profissional)) return null;
      if (auxiliar && slot.profissional !== auxiliar) return null;
      auxiliar = slot.profissional;
    }
    out.push({ ...slot, papel: etapa.papel });
  }
  return { oferta, comprimento, principal, ...(auxiliar ? { auxiliar } : {}), slots: out };
}

/** `remarcar:<slot_id>`: a slot offered to move one appointment. */
export const OPCAO_REMARCAR = "remarcar";

export function parseSlotId(slotId: string) {
  const m = SLOT_ID.exec(slotId);
  return m
    ? { profissional: m[1]!, servico: m[2]!, data: m[3]!, inicio: Number(m[4]) * 60 + Number(m[5]) }
    : null;
}
