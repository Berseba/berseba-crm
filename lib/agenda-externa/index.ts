/**
 * Resolução da agenda externa DE UMA ORGANIZAÇÃO.
 *
 * Toda a superfície pública do módulo passa por aqui, e toda entrada exige
 * `organizationId`. Não existe caminho que leia configuração de agenda externa
 * sem dizer de quem — é o que impede que a grade de um cliente responda a uma
 * pergunta feita no funil de outro.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { diaLocalISO } from "@/lib/agenda/fuso";
import { criarAdaptadorAdminFit } from "./adminfit";
import type {
  AdaptadorDeAgendaExterna,
  ConfigDeAgendaExterna,
  ConsultaDeVagas,
  PerguntaDeVagas,
} from "./tipos";

export type {
  AdaptadorDeAgendaExterna,
  ConfigDeAgendaExterna,
  ConsultaDeVagas,
  ModalidadeExterna,
  PerguntaDeVagas,
  ProvedorDeAgendaExterna,
  VagaExterna,
} from "./tipos";
export { criarAdaptadorAdminFit } from "./adminfit";

/** Horizonte padrão e teto, em dias. */
export const DIAS_PADRAO = 7;
export const DIAS_MAX = 21;

/**
 * Por que existe um teto de 21 dias: a grade do Studio só abre a semana
 * seguinte às quintas, então pedir 60 dias devolve as mesmas duas semanas com
 * um custo de leitura maior e uma lista mais longa entrando inteira no contexto
 * do turno. Teto baixo aqui não perde informação — ela não existe ainda.
 */

/**
 * Pergunta como o CRM a faz: em DIAS A PARTIR DE AGORA, não em datas.
 *
 * ⚠️ QUEM CHAMA NÃO PODE MONTAR O INTERVALO. O primeiro dia da grade depende do
 * fuso da agenda do cliente, e o fuso só é conhecido depois de ler a
 * configuração DELE — que acontece aqui dentro. Um chamador que calculasse
 * `hoje` com o relógio do servidor erraria o dia inteiro perto da meia-noite,
 * e erraria em silêncio: a lista voltaria plausível, só que deslocada.
 */
export interface PerguntaEmDias {
  modalidade: string;
  diasAFrente: number;
}

/**
 * Lê e valida `organizations.settings.agenda_externa`.
 *
 * Configuração malformada devolve `null` (= organização sem agenda externa) em
 * vez de lançar. Uma linha de `settings` com um campo trocado não pode derrubar
 * o turno de atendimento inteiro; ela só faz o CRM voltar a ser a única fonte
 * de horário, que é o comportamento de quem nunca configurou nada.
 */
export function lerConfig(settings: unknown): ConfigDeAgendaExterna | null {
  if (!settings || typeof settings !== "object") return null;
  const bruto = (settings as Record<string, unknown>).agenda_externa;
  if (!bruto || typeof bruto !== "object") return null;

  const o = bruto as Record<string, unknown>;
  if (o.provedor !== "adminfit") return null;
  if (typeof o.baseUrl !== "string" || !o.baseUrl) return null;
  if (typeof o.fuso !== "string" || !o.fuso) return null;
  if (!o.modalidades || typeof o.modalidades !== "object") return null;

  const modalidades: Record<string, { rotulo: string; externo: string }> = {};
  for (const [chave, v] of Object.entries(o.modalidades as object)) {
    if (!v || typeof v !== "object") continue;
    const m = v as Record<string, unknown>;
    if (typeof m.rotulo !== "string" || typeof m.externo !== "string") continue;
    if (!m.rotulo || !m.externo) continue;
    modalidades[chave] = { rotulo: m.rotulo, externo: m.externo };
  }
  // Configuração sem nenhuma modalidade válida é configuração que não consulta
  // nada. Devolver um adaptador vazio faria a tool responder "sem vagas", que
  // é uma mentira com cara de resposta.
  if (Object.keys(modalidades).length === 0) return null;

  return {
    provedor: "adminfit",
    baseUrl: o.baseUrl,
    fuso: o.fuso,
    modalidades,
  };
}

export function criarAdaptador(
  config: ConfigDeAgendaExterna,
): AdaptadorDeAgendaExterna {
  switch (config.provedor) {
    case "adminfit":
      return criarAdaptadorAdminFit(config);
  }
}

/**
 * Consulta a grade externa de uma organização.
 *
 * ⚠️ `supabase` é service role e passa por cima da RLS — a query abaixo filtra
 * `id` pela organização recebida, e é isso que separa esta chamada de um
 * vazamento entre clientes.
 */
export async function consultarVagasDaOrg(
  supabase: SupabaseClient,
  organizationId: string,
  pergunta: PerguntaEmDias,
): Promise<ConsultaDeVagas> {
  const dias = Math.min(Math.max(Math.trunc(pergunta.diasAFrente), 1), DIAS_MAX);

  const { data, error } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();

  if (error) {
    return { situacao: "indisponivel", motivo: `falha ao ler configuração: ${error.message}` };
  }

  const config = lerConfig(data?.settings);
  if (!config) return { situacao: "nao_configurado" };

  const agora = new Date();
  const fim = new Date(agora.getTime() + dias * 24 * 60 * 60 * 1000);
  const intervalo: PerguntaDeVagas = {
    modalidade: pergunta.modalidade,
    de: diaLocalISO(agora, config.fuso),
    ate: diaLocalISO(fim, config.fuso),
  };

  return criarAdaptador(config).consultar(intervalo);
}
