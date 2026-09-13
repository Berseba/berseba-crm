/**
 * O VOCABULÁRIO FECHADO DE NICHO DA ORGANIZAÇÃO — fonte única dos dois lados.
 *
 * `organizations.settings.nicho` liga os dois freios clínicos determinísticos
 * (`checkG4Medical` em `lib/ai/handoff/triggers.ts`, `clinicalScopeGate` via
 * `lib/agent-engine/guardrails/escopo-clinico.ts`) quando vale `"saude"` — ver
 * `lerNichoDaOrg`/`nichoEhSaude` em `lib/agent-engine/guardrails/camadas-da-org.ts`.
 * Até esta mudança não havia tela para gravar o valor: violava o invariante 6
 * da doutrina do sistema vivo ("toda configuração tem superfície").
 *
 * Este módulo é a ÚNICA declaração do vocabulário. A rota
 * `app/api/v1/settings/nicho/route.ts` (escrita) e `camadas-da-org.ts`
 * (leitura, via `NICHO_SAUDE`) importam daqui — nunca redeclaram a lista, e o
 * `nichoEhSaude` correspondente compara contra a MESMA constante que a rota
 * valida. Divergir os dois lados é o defeito que este arquivo existe para
 * impedir.
 *
 * Os cinco valores são os nichos que `CLAUDE.md` (produto) já nomeia na Visão:
 * "multi-nicho (e-commerce, clínicas, imobiliárias, infoprodutos, serviços)".
 * `saude` é o nome interno de "clínicas" — mesmo domínio, vocabulário do
 * schema em vez da prosa de venda.
 *
 * `null` = organização não escolheu (estado de toda org antes de alguém
 * clicar). Nunca um sexto valor tipo "nenhum" gravado no banco — `null` já
 * expressa isso, e um clone existente não ganha nicho nenhum por causa desta
 * mudança (zero migration, zero diferença).
 */
import { z } from "zod";

export const NICHOS = [
  "saude",
  "ecommerce",
  "imobiliaria",
  "infoproduto",
  "servicos",
] as const;

export type Nicho = (typeof NICHOS)[number];

/**
 * O único nicho que arma os freios clínicos hoje — reexportado por
 * `camadas-da-org.ts` para quem já importa dali. Mudar este valor sem mudar
 * os freios seria o mesmo bug que este módulo existe para prevenir do lado
 * oposto (vocabulário divergente).
 */
export const NICHO_SAUDE: Nicho = "saude";

/**
 * Schema Zod do valor gravado em `organizations.settings.nicho`: um dos cinco
 * valores fechados, ou `null` (nenhum). Usado pela rota GET/PATCH e por
 * qualquer outro leitor que precise validar o jsonb antes de confiar nele.
 */
export const nichoSchema = z.enum(NICHOS).nullable();

/** Rótulo pt-BR pra tela — não é vocabulário de banco, só apresentação. */
export const NICHO_LABELS: Record<Nicho, string> = {
  saude: "Saúde",
  ecommerce: "E-commerce",
  imobiliaria: "Imobiliária",
  infoproduto: "Infoproduto",
  servicos: "Serviços",
};
