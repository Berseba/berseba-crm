/**
 * Berseba: the avec waitlist's engine — find a slot for each entry in order, hold it for one
 * person, send the offer, and give the slot to the next one when the deadline passes.
 *
 * The storage, the channel and the agenda are ports, so the flow is proved step by step in
 * `lista-de-espera-motor.berseba.test.ts`; the Supabase/avec implementations live in
 * `lista-de-espera-supabase.ts`. `agora` is always a parameter.
 */
import type { ConfigDaListaDeEspera } from "@/lib/agenda/lista-de-espera";

import {
  chaveDaVaga,
  hojeNoSalao,
  janelaDeBusca,
  ocupacaoDa,
  ordenarFilaAvec,
  prazoDaOfertaAvec,
  textoDaOfertaAvec,
  vagaParaInscricao,
  type InscricaoAvec,
  type Ocupacao,
  type PedidoDaEspera,
} from "./lista-de-espera";
import type { Opcao } from "./ofertas";

/** The offer stored on the entry (`avec_waitlist.oferta`). */
export interface OfertaGuardada {
  opcao_id: string;
  data: string;
  inicio: string;
  fim: string;
  profissional: string;
  auxiliar: string | null;
  servico_rotulo: string;
  profissional_nome: string | null;
  ocupacao: Ocupacao[];
}

export interface RepoDaEspera {
  /** The entries `waiting`, any order. */
  fila(org: string): Promise<InscricaoAvec[]>;
  /** What the offers in progress hold, with the contact each one is for. */
  seguradas(org: string, agora: Date): Promise<Array<{ contactId: string; ocupacao: Ocupacao[] }>>;
  /** `waiting` → `offered`. `false` = the entry changed or the slot is held already. */
  ofertar(org: string, id: string, oferta: OfertaGuardada, chave: string, expiraEm: Date, agora: Date): Promise<boolean>;
  /** Back to `waiting`; `recusada` is remembered so the same slot is never offered again. */
  voltarParaFila(org: string, id: string, recusada: string | null, agora: Date): Promise<void>;
  /** Offers whose deadline passed: their id and slot key. */
  vencidas(org: string, agora: Date): Promise<Array<{ id: string; chave: string | null }>>;
  /** Live entries whose last day is before `hoje` become `expired`. Returns how many. */
  encerrarPassadas(org: string, hoje: string, agora: Date): Promise<number>;
  nomeDoContato(org: string, contactId: string): Promise<string | null>;
}

export interface CanalDaEspera {
  /** The message can go out now (contact reachable, channel window open, pacing). */
  podeAvisar(org: string, contactId: string): Promise<boolean>;
  /** `false` = it did not go out. */
  avisar(org: string, contactId: string, texto: string): Promise<boolean>;
}

export interface AgendaDaEspera {
  /** Every visit avec allows for the request between the two days; `null` = request no longer valid. */
  opcoes(pedido: PedidoDaEspera, de: string, ate: string): Promise<Opcao[] | null>;
  rotuloDoServico(servico: string): string;
  nomeDoProfissional(id: string): string | null;
}

export interface PortasDaEspera {
  repo: RepoDaEspera;
  canal: CanalDaEspera;
  agenda: AgendaDaEspera;
}

export interface ResultadoDaBusca {
  avaliadas: number;
  ofertadas: number;
}

/** At most this many entries are searched per round: each one costs avec calls. */
export const TETO_DA_RODADA = 40;

/**
 * Searches avec for each waiting entry, in the queue's order, and offers the first slot that
 * serves her. A slot offered in this round is held for the rest of it, so the next entries never
 * get the same one. `soInscricao` limits the round to one entry (the "Procurar agora" button).
 */
export async function procurarVagas(
  portas: PortasDaEspera,
  org: string,
  config: ConfigDaListaDeEspera,
  agora: Date,
  opcoes: { soInscricao?: string } = {},
): Promise<ResultadoDaBusca> {
  const { repo, canal, agenda } = portas;
  const hoje = hojeNoSalao(agora);
  let fila = ordenarFilaAvec(await repo.fila(org));
  if (opcoes.soInscricao) fila = fila.filter((i) => i.id === opcoes.soInscricao);
  const seguradas = await repo.seguradas(org, agora);
  const ocupadas: Ocupacao[] = seguradas.flatMap((s) => s.ocupacao);
  // One offer per client at a time, even with two entries (two services).
  const comOferta = new Set(seguradas.map((s) => s.contactId));
  // One avec search per request and window: two entries asking the same thing share it.
  const cache = new Map<string, Promise<Opcao[] | null>>();
  const buscar = (pedido: PedidoDaEspera, de: string, ate: string) => {
    const chave = JSON.stringify([pedido.servico, pedido.comprimento, pedido.profissional, de, ate]);
    if (!cache.has(chave)) cache.set(chave, agenda.opcoes(pedido, de, ate));
    return cache.get(chave)!;
  };

  let avaliadas = 0;
  let ofertadas = 0;
  for (const inscricao of fila.slice(0, TETO_DA_RODADA)) {
    if (comOferta.has(inscricao.contactId)) continue;
    const janela = janelaDeBusca(inscricao, hoje);
    if (!janela) continue;
    avaliadas += 1;
    const lista = await buscar(inscricao.pedido, janela.de, janela.ate);
    if (!lista?.length) continue;
    const vaga = vagaParaInscricao(inscricao, lista, ocupadas, agora, config);
    if (!vaga) continue;
    const expiraEm = prazoDaOfertaAvec(vaga, agora, config);
    if (!expiraEm) continue;
    if (!(await canal.podeAvisar(org, inscricao.contactId))) continue;

    const oferta: OfertaGuardada = {
      opcao_id: vaga.opcao_id,
      data: vaga.data,
      inicio: vaga.inicio,
      fim: vaga.fim,
      profissional: vaga.profissional,
      auxiliar: vaga.auxiliar ?? null,
      servico_rotulo: agenda.rotuloDoServico(inscricao.pedido.servico),
      profissional_nome: agenda.nomeDoProfissional(vaga.profissional),
      ocupacao: ocupacaoDa(vaga),
    };
    const chave = chaveDaVaga(vaga);
    if (!(await repo.ofertar(org, inscricao.id, oferta, chave, expiraEm, agora))) continue;

    const texto = textoDaOfertaAvec({
      nome: await repo.nomeDoContato(org, inscricao.contactId),
      servico: oferta.servico_rotulo,
      profissional: oferta.profissional_nome,
      opcao: vaga,
      expiraEm,
      substituiData: inscricao.substituiData,
    });
    if (await canal.avisar(org, inscricao.contactId, texto)) {
      ocupadas.push(...oferta.ocupacao);
      comOferta.add(inscricao.contactId);
      ofertadas += 1;
    } else {
      // A slot held for someone who was not told is a stuck slot: release it now.
      await repo.voltarParaFila(org, inscricao.id, null, agora);
    }
  }
  return { avaliadas, ofertadas };
}

/**
 * The round of the cron: entries whose days are over leave the list, offers past their deadline
 * go back to the queue (the slot is remembered as refused), then the search runs.
 */
export async function rodadaDaEspera(
  portas: PortasDaEspera,
  org: string,
  config: ConfigDaListaDeEspera,
  agora: Date,
): Promise<ResultadoDaBusca & { vencidas: number; encerradas: number }> {
  const encerradas = await portas.repo.encerrarPassadas(org, hojeNoSalao(agora), agora);
  const vencidas = await portas.repo.vencidas(org, agora);
  for (const v of vencidas) await portas.repo.voltarParaFila(org, v.id, v.chave, agora);
  const busca = await procurarVagas(portas, org, config, agora);
  return { ...busca, vencidas: vencidas.length, encerradas };
}
