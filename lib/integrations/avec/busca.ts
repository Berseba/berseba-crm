/**
 * Berseba: the salon's visit options for one request, read from avec.
 *
 * Shared by `avec_free_slots` (the agent's search) and the waitlist (`lista-de-espera-supabase.ts`),
 * so both build visits with the same recipe: principal steps, the helper's washing and drying,
 * the hair length and the "no Saturday" services.
 */
import { listAvailability } from "./client";
import type { AvecConfig } from "./config";
import { consultasPara, montarOpcoes, ofertaPorId, etapasDe, type Comprimento, type Opcao, type Salao } from "./ofertas";

/** Lowercase, no accents, single spaces: how names are compared. */
export const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** The professionals of an oferta the client accepts: all, or the one she named (id or name). */
export function principaisPara(
  salao: Salao,
  oferta: NonNullable<ReturnType<typeof ofertaPorId>>,
  profissional: string | null | undefined,
): string[] | null {
  const todas = oferta.porProfissional.map((p) => p.profissional);
  if (!profissional) return todas;
  const alvo = fold(profissional);
  const achadas = todas.filter((id) => {
    const nome = fold(salao.profissionais[id]?.nome ?? "");
    return id === profissional.trim() || nome === alvo || nome.split(" ")[0] === alvo;
  });
  return achadas.length ? achadas : null;
}

export type PedidoInvalido =
  | "servico_desconhecido"
  | "precisa_comprimento"
  | "profissional_nao_faz"
  | "comprimento_com_a_equipe";

/** Checks a request against the salon's recipes, before anything is searched or stored. */
export function conferirPedido(
  salao: Salao,
  pedido: { servico: string; comprimento: Comprimento | null; profissional: string | null },
): { ok: true; principais: string[]; comprimento: Comprimento | null } | { ok: false; motivo: PedidoInvalido } {
  const oferta = ofertaPorId(salao, pedido.servico);
  if (!oferta) return { ok: false, motivo: "servico_desconhecido" };
  const comprimento = oferta.comprimento ? pedido.comprimento : null;
  if (oferta.comprimento && !comprimento) return { ok: false, motivo: "precisa_comprimento" };
  const principais = principaisPara(salao, oferta, pedido.profissional);
  if (!principais) return { ok: false, motivo: "profissional_nao_faz" };
  if (principais.every((p) => etapasDe(oferta, p, comprimento) === null)) {
    return { ok: false, motivo: "comprimento_com_a_equipe" };
  }
  return { ok: true, principais, comprimento };
}

/**
 * Every visit avec allows for this request between `from` and `to` (inclusive, at most 14 days),
 * before any preference filter. `null` when the request does not fit the salon's recipes.
 */
export async function opcoesDoPedido(
  config: AvecConfig,
  salao: Salao,
  pedido: { servico: string; comprimento: Comprimento | null; profissional: string | null },
  from: string,
  to: string,
): Promise<Opcao[] | null> {
  const conferido = conferirPedido(salao, pedido);
  if (!conferido.ok) return null;
  const oferta = ofertaPorId(salao, pedido.servico)!;
  const consultas = consultasPara(salao, oferta, conferido.principais, conferido.comprimento);
  const slots = (
    await Promise.all(
      consultas.map((c) =>
        listAvailability(config, { service_id: c.servico, professional_id: c.profissional, from, to }),
      ),
    )
  ).flat();
  return montarOpcoes(salao, oferta, conferido.principais, conferido.comprimento, slots).filter(
    (o) => !oferta.semSabado || new Date(`${o.data}T12:00:00Z`).getUTCDay() !== 6,
  );
}
