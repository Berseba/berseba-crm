/**
 * G4_MEDICAL — urgência médica relatada pelo contato (freio clínico 1, Berseba).
 *
 * Opt-in por `organizations.settings->>'nicho' = 'saude'` — o CALLER decide se
 * este check roda; a função em si é pura e nicho-agnóstica, como `checkG4Legal`.
 *
 * Mora fora de `triggers.ts` de propósito: aquele arquivo é dos gates fixos que
 * só o worker legado roda (cerca `tests/unit/gates-fixos-so-no-legado.test.ts`),
 * e este roda no agent-engine (`inbound-turn.ts`). Ver BERSEBA.md.
 *
 * Normaliza (minúsculas, sem acento) antes de testar — ver o comentário de
 * `G4_MEDICAL_REGEX` em `regex.ts` para o porquê de esta camada, sozinha
 * entre as G1-G4, precisar de normalização.
 */
import { G4_MEDICAL_REGEX, normalizeForG4Medical } from "@/lib/ai/handoff/regex";

export function checkG4Medical(body: string): boolean {
  if (!body) return false;
  return G4_MEDICAL_REGEX.test(normalizeForG4Medical(body));
}
