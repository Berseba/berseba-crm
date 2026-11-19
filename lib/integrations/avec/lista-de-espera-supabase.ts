/**
 * Berseba: the avec waitlist's ports over Supabase, avec and the CRM's outbound path.
 *
 * Every chain filters by `organization_id` (the admin-client tenant fence). The channel reuses
 * upstream's waitlist port (`portaSupabase` of `lib/agenda/encaixe-supabase.ts`): contact
 * guards, the channel's sending window and pacing, and the send through `sendMessageHandler`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { configDaEspera, portaSupabase } from "@/lib/agenda/encaixe-supabase";
import type { ConfigDaListaDeEspera } from "@/lib/agenda/lista-de-espera";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { opcoesDoPedido } from "./busca";
import { avecConfigFor } from "./config";
import { pedidoDaEsperaSchema, sobrepoe, type InscricaoAvec, type Ocupacao } from "./lista-de-espera";
import {
  procurarVagas,
  rodadaDaEspera,
  soltarOfertas,
  type AgendaDaEspera,
  type OfertaGuardada,
  type PortasDaEspera,
  type RepoDaEspera,
} from "./lista-de-espera-motor";
import { ofertaPorId, salaoDa, type Salao } from "./ofertas";

type SB = SupabaseClient;

const TABELA = "avec_waitlist";
const VIVAS = ["waiting", "offered"] as const;

export const COLUNAS_DA_INSCRICAO =
  "id, contact_id, pedido, data_de, data_ate, depois_de, ate, substitui_data, ordem, created_at, recusadas";

const hhmm = (v: unknown) => (typeof v === "string" && v.length >= 5 ? v.slice(0, 5) : null);

/** A row → the decision's vocabulary; `null` = unreadable row (left out of the queue). */
export function lerInscricao(linha: Record<string, unknown>): InscricaoAvec | null {
  const pedido = pedidoDaEsperaSchema.safeParse(linha.pedido);
  const createdAt = typeof linha.created_at === "string" ? new Date(linha.created_at) : null;
  if (
    !pedido.success ||
    typeof linha.id !== "string" ||
    typeof linha.contact_id !== "string" ||
    typeof linha.data_de !== "string" ||
    typeof linha.data_ate !== "string" ||
    !createdAt ||
    Number.isNaN(createdAt.getTime())
  ) {
    return null;
  }
  return {
    id: linha.id,
    contactId: linha.contact_id,
    pedido: pedido.data,
    dataDe: linha.data_de,
    dataAte: linha.data_ate,
    depoisDe: hhmm(linha.depois_de),
    ate: hhmm(linha.ate),
    substituiData: typeof linha.substitui_data === "string" ? linha.substitui_data : null,
    ordem: Number(linha.ordem ?? 0),
    createdAt,
    recusadas: Array.isArray(linha.recusadas) ? (linha.recusadas as string[]) : [],
  };
}

/** The offer stored on a row, or `null`. */
export function lerOferta(v: unknown): OfertaGuardada | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<OfertaGuardada>;
  if (typeof o.opcao_id !== "string" || typeof o.data !== "string" || typeof o.inicio !== "string") return null;
  return o as OfertaGuardada;
}

export function repoSupabase(admin: SB): RepoDaEspera {
  return {
    async fila(org) {
      const { data, error } = await admin
        .from(TABELA)
        .select(COLUNAS_DA_INSCRICAO)
        .eq("organization_id", org)
        .eq("status", "waiting")
        .order("ordem", { ascending: true })
        .limit(200);
      if (error) throw new Error(`avec_waitlist: fila: ${error.message}`);
      const fila: InscricaoAvec[] = [];
      for (const linha of (data ?? []) as Record<string, unknown>[]) {
        const inscricao = lerInscricao(linha);
        if (inscricao) fila.push(inscricao);
        else logger.warn("avec_waitlist: unreadable entry left out", { espera_id: linha.id });
      }
      return fila;
    },

    async seguradas(org, agora) {
      const { data, error } = await admin
        .from(TABELA)
        .select("contact_id, oferta")
        .eq("organization_id", org)
        .eq("status", "offered")
        .gt("oferta_expira_em", agora.toISOString())
        .limit(200);
      if (error) throw new Error(`avec_waitlist: seguradas: ${error.message}`);
      return ((data ?? []) as Array<{ contact_id: string; oferta: unknown }>).map((l) => ({
        contactId: l.contact_id,
        ocupacao: lerOferta(l.oferta)?.ocupacao ?? [],
      }));
    },

    async ofertar(org, id, oferta, chave, expiraEm, agora) {
      const { data, error } = await admin
        .from(TABELA)
        .update({
          status: "offered",
          oferta,
          oferta_chave: chave,
          oferta_expira_em: expiraEm.toISOString(),
          ofertada_em: agora.toISOString(),
          updated_at: agora.toISOString(),
        })
        .eq("organization_id", org)
        .eq("id", id)
        .eq("status", "waiting")
        .select("id");
      // 23505: another round holds this slot already (`uniq_avec_waitlist_vaga_segurada`).
      if (error) {
        if (error.code === "23505") return false;
        throw new Error(`avec_waitlist: ofertar: ${error.message}`);
      }
      return (data ?? []).length === 1;
    },

    async conflita(org, id, contactId, ocupacao, agora) {
      const { data, error } = await admin
        .from(TABELA)
        .select("id, contact_id, oferta")
        .eq("organization_id", org)
        .eq("status", "offered")
        .gt("oferta_expira_em", agora.toISOString())
        .neq("id", id)
        .limit(200);
      if (error) throw new Error(`avec_waitlist: conflita: ${error.message}`);
      return ((data ?? []) as Array<{ contact_id: string; oferta: unknown }>).some(
        (l) => l.contact_id === contactId || sobrepoe(lerOferta(l.oferta)?.ocupacao ?? [], ocupacao),
      );
    },

    async voltarParaFila(org, id, recusada, agora) {
      const { data: atual, error: erroLeitura } = await admin
        .from(TABELA)
        .select("recusadas")
        .eq("organization_id", org)
        .eq("id", id)
        .maybeSingle();
      if (erroLeitura) throw new Error(`avec_waitlist: voltar: ${erroLeitura.message}`);
      const recusadas = new Set<string>(((atual as { recusadas?: string[] } | null)?.recusadas ?? []));
      if (recusada) recusadas.add(recusada);
      const { error } = await admin
        .from(TABELA)
        .update({
          status: "waiting",
          oferta: null,
          oferta_chave: null,
          oferta_expira_em: null,
          ofertada_em: null,
          recusadas: [...recusadas].slice(-50),
          updated_at: agora.toISOString(),
        })
        .eq("organization_id", org)
        .eq("id", id)
        .eq("status", "offered");
      if (error) throw new Error(`avec_waitlist: voltar: ${error.message}`);
    },

    async vencidas(org, agora) {
      const { data, error } = await admin
        .from(TABELA)
        .select("id, oferta_chave")
        .eq("organization_id", org)
        .eq("status", "offered")
        .lte("oferta_expira_em", agora.toISOString())
        .limit(200);
      if (error) throw new Error(`avec_waitlist: vencidas: ${error.message}`);
      return ((data ?? []) as Array<{ id: string; oferta_chave: string | null }>).map((l) => ({
        id: l.id,
        chave: l.oferta_chave,
      }));
    },

    async encerrarPassadas(org, hoje, agora) {
      const { data, error } = await admin
        .from(TABELA)
        .update({ status: "expired", encerrada_em: agora.toISOString(), updated_at: agora.toISOString() })
        .eq("organization_id", org)
        .in("status", [...VIVAS])
        .lt("data_ate", hoje)
        .select("id");
      if (error) throw new Error(`avec_waitlist: encerrar: ${error.message}`);
      return (data ?? []).length;
    },

    async nomeDoContato(org, contactId) {
      const { data, error } = await admin
        .from("contacts")
        .select("name")
        .eq("organization_id", org)
        .eq("id", contactId)
        .maybeSingle();
      if (error || !data) return null;
      const linha = data as { name?: string | null };
      // The first name only goes in the message when the contact has a real name.
      return linha.name?.trim() || null;
    },
  };
}

/** The salon of the organization, or `null` when it does not use avec. */
export function salaoDaOrganizacao(org: string): Salao | null {
  return avecConfigFor(org) ? salaoDa(org) : null;
}

/** avec's side of the ports for one organization, or `null` when it has no salon or no avec. */
export function agendaAvec(org: string): AgendaDaEspera | null {
  const config = avecConfigFor(org);
  const salao = salaoDa(org);
  if (!config || !salao) return null;
  return {
    opcoes: (pedido, de, ate) => opcoesDoPedido(config, salao, pedido, de, ate),
    rotuloDoServico: (servico) => ofertaPorId(salao, servico)?.rotulo ?? servico,
    nomeDoProfissional: (id) => salao.profissionais[id]?.nome ?? null,
  };
}

export function portasAvec(admin: SB, org: string): PortasDaEspera | null {
  const agenda = agendaAvec(org);
  if (!agenda) return null;
  const canal = portaSupabase(admin);
  return {
    repo: repoSupabase(admin),
    canal: { podeAvisar: canal.podeAvisar, avisar: canal.avisar },
    agenda,
  };
}

/** The organization's waitlist settings when it is on (and the org is operating), else `null`. */
export function configDaEsperaAvec(admin: SB, org: string): Promise<ConfigDaListaDeEspera | null> {
  return configDaEspera(admin, org);
}

/** One full round for one organization (the cron). `null` = off for it. */
export async function rodadaAvec(admin: SB, org: string, agora: Date) {
  const config = await configDaEsperaAvec(admin, org);
  if (!config) {
    // Switched off (or the org stopped): no offer stays held.
    const soltas = await soltarOfertas(repoSupabase(admin), org, agora);
    return soltas ? { avaliadas: 0, ofertadas: 0, vencidas: 0, encerradas: 0, soltas } : null;
  }
  const portas = portasAvec(admin, org);
  if (!portas) return null;
  return rodadaDaEspera(portas, org, config, agora);
}

/** Searches now, for the whole queue or one entry. `null` = off for this organization. */
export async function procurarAgoraAvec(admin: SB, org: string, agora: Date, soInscricao?: string) {
  const config = await configDaEsperaAvec(admin, org);
  const portas = config ? portasAvec(admin, org) : null;
  if (!config || !portas) return null;
  return procurarVagas(portas, org, config, agora, soInscricao ? { soInscricao } : {});
}

/**
 * Fire-and-forget search after something freed a slot in avec (the agent cancelled, moved or
 * swapped a visit). Never throws: the cron runs the same search a few minutes later.
 */
export function dispararBuscaDaEspera(org: string): void {
  void procurarAgoraAvec(createAdminClient(), org, new Date()).catch((erro: unknown) => {
    logger.warn("avec_waitlist: search after a freed slot failed", {
      organization_id: org,
      error: erro instanceof Error ? erro.message : String(erro),
    });
  });
}

/**
 * The client booked this service herself (`avec_book`) on a day she was waiting for: those
 * entries leave the list, and a slot held for her is free again. A booking outside her days (the
 * fallback visit she keeps while waiting for an earlier one) leaves the entry alone. Never
 * throws: a missed close only costs a later offer.
 */
export async function encerrarAoMarcar(
  org: string,
  contactId: string,
  servico: string,
  dia: string,
  agora: Date,
): Promise<void> {
  try {
    const { data, error } = await createAdminClient()
      .from("avec_waitlist")
      .update({
        status: "booked",
        resultado: { via: "avec_book" },
        encerrada_em: agora.toISOString(),
        updated_at: agora.toISOString(),
      })
      .eq("organization_id", org)
      .eq("contact_id", contactId)
      .eq("pedido->>servico", servico)
      .lte("data_de", dia)
      .gte("data_ate", dia)
      .in("status", [...VIVAS])
      .select("id, status");
    if (error) throw new Error(error.message);
    if ((data ?? []).length) dispararBuscaDaEspera(org);
  } catch (erro) {
    logger.warn("avec_waitlist: entry not closed after a booking", {
      organization_id: org,
      error: erro instanceof Error ? erro.message : String(erro),
    });
  }
}

/** What the offers in progress hold, for every contact but `excetoContato`. */
export async function ocupacoesSeguradasPorOutras(
  db: SB,
  org: string,
  excetoContato: string | null,
  agora: Date,
): Promise<Ocupacao[]> {
  const seguradas = await repoSupabase(db).seguradas(org, agora);
  return seguradas.filter((s) => s.contactId !== excetoContato).flatMap((s) => s.ocupacao);
}
