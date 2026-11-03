/**
 * Berseba: a reply turn that the promise reviewer silenced goes to the team.
 *
 * A veto from the semantic promise layer is a teaching error: the model rewrites
 * and tries again. When every attempt is vetoed, the turn ends with nothing sent,
 * and upstream treats the veto as the legitimate reason for the silence
 * (`turno-mudo.ts` only corrects turns with no send attempt). At the Mayara
 * Morales salon that left a client who said "Sim" to a booking with no answer
 * (30/10): the visit was in avec, the confirmation was vetoed five times, and
 * nobody was told. The same happened on 24/10.
 *
 * Releasing the vetoed text is not safe (the promise may be real: a discount, a
 * free service). Passing the conversation to the team is: the client gets the
 * generic handoff notice and a person answers.
 *
 * The caller checks the preview before calling: a preview has no live job.
 */

export const POR_QUE_DO_TURNO_CALADO =
  "A revisão de promessas barrou todas as respostas que a IA tentou enviar neste turno, e o cliente ficou sem resposta.";

export function turnoCaladoPorVetoPedePassagem(t: {
  turnoDeResposta: boolean;
  enviadas: number;
  vetosDePromessa: number;
  turnoDescartado: boolean;
  passouParaAEquipe: boolean;
  capDeEnvio: boolean;
}): boolean {
  return (
    t.turnoDeResposta &&
    t.enviadas === 0 &&
    t.vetosDePromessa > 0 &&
    !t.turnoDescartado &&
    !t.passouParaAEquipe &&
    !t.capDeEnvio
  );
}
