/**
 * Berseba corpus for the clinical-claim detector — physiotherapy/pilates.
 *
 * Upstream's corpus (`afirmacao-clinica.test.ts`) is dermatology. These cases came from
 * the `clinical_scope` gate that Clínica FitVision ran until issue Berseba/berseba-crm#35
 * replaced it with upstream's layer; measured before the vocabulary was ported, upstream's
 * detector let 9 of its 12 veto cases through. Kept in a file of our own so an upstream
 * sync never conflicts on it.
 *
 * Deliberately NOT ported:
 *  - "seu problema é …": at a reception desk "entendi, seu problema é o horário de sábado"
 *    is routine, and the diagnosis it was meant to catch is already caught by
 *    "você tem / isso é <condition>".
 *  - a drug name with no verb and no efficacy claim ("o ibuprofeno que você comentou…"):
 *    the old gate barred any mention, which also barred the reply that sends the patient
 *    to their doctor. A use/recommending verb or "<drug> ajuda/alivia…" still bars.
 */
import { describe, expect, it } from 'vitest';

import { vetoReason } from '@/lib/leads/veto-activity';

import { detectarAfirmacaoClinica, type CategoriaClinica } from './afirmacao-clinica';

const bars: Array<[CategoriaClinica, string]> = [
  ['diagnostico', 'Você tem tendinite no ombro.'],
  ['diagnostico', 'Você está com uma hérnia de disco.'],
  ['diagnostico', 'Isso é bursite mesmo.'],
  ['diagnostico', 'Seu diagnóstico é escoliose leve.'],
  ['diagnostico', 'Pelo que você contou, você tem uma lesão muscular.'],
  ['diagnostico', 'Vc tá com fascite plantar.'],
  ['diagnostico', 'Você tem compressão nervosa.'],
  ['diagnostico', 'Você está com rompimento do ligamento.'],
  ['diagnostico', 'Você tem uma ruptura parcial do tendão.'],
  ['diagnostico', 'Isso é uma contratura.'],
  ['diagnostico', 'Você está com inflamação crônica no joelho.'],
  ['diagnostico', 'Você tem bursopatia no ombro.'],
  ['prescricao', 'Tome 2 comprimidos de ibuprofeno de 8 em 8 horas.'],
  ['prescricao', 'Use dipirona se a dor voltar.'],
  ['prescricao', 'Pode tomar 600mg de ibuprofeno agora.'],
  ['prescricao', 'Recomendo tomar um analgésico antes da sessão.'],
  ['prescricao', 'Pode tomar um relaxante muscular à noite.'],
  ['prescricao', 'Recomendo ibuprofeno.'],
  ['prescricao', 'Sugiro um analgésico antes da aula.'],
  ['prescricao', 'Ibuprofeno ajuda nessa dor.'],
  ['prescricao', 'Tome 2 comprimidos antes da aula.'],
  ['promessa_de_resultado', 'Isso vai curar rapidinho.'],
  ['promessa_de_resultado', 'Garantimos que a dor some em uma semana.'],
  ['promessa_de_resultado', 'Temos garantia de cura para esse quadro.'],
  ['promessa_de_resultado', 'Garantimos a cura da sua lombalgia.'],
  // Portuguese "no" is "em + o", not a negation (review of #40)
  ['promessa_de_resultado', 'No seu caso vai curar em poucas sessões.'],
  ['promessa_de_resultado', 'No pilates o tratamento vai curar.'],
  // a conditional promise is still a promise, with or without the comma
  ['promessa_de_resultado', 'Se fizer as sessões vai curar.'],
  ['promessa_de_resultado', 'Se fizer as sessões, vai curar.'],
  // ─── Spanish ─────────────────────────────────────────────────────────────────
  ['diagnostico', 'Usted tiene tendinitis en el hombro.'],
  ['diagnostico', 'Tienes una hernia de disco.'],
  ['diagnostico', 'Eso es un esguince.'],
  ['prescricao', 'Tome dos pastillas de ibuprofeno cada 8 horas.'],
  ['prescricao', 'Puede tomar paracetamol si vuelve el dolor.'],
  ['promessa_de_resultado', 'Esto va a curar rápido.'],
  ['promessa_de_resultado', 'Garantizamos que el dolor desaparece en una semana.'],
  ['prescricao', 'Le recomiendo ibuprofeno.'],
];

const passes: string[] = [
  'A avaliação com o fisioterapeuta vai identificar o que está acontecendo.',
  'Cada caso é avaliado presencialmente antes de qualquer indicação.',
  'Podemos agendar uma sessão de avaliação para o profissional te examinar.',
  'O exercício que você fez hoje é só parte do protocolo.',
  'Nossos preços de sessão avulsa e pacote estão na tabela que te mandei.',
  'Use uma roupa confortável para a sessão de pilates.',
  'Tome cuidado ao descer da maca, pode escorregar.',
  'Vamos marcar sua sessão de retorno para a próxima semana.',
  'Você tem razão, esse horário não fecha — vou verificar outro.',
  'Você tem que trazer o encaminhamento médico na primeira sessão.',
  // the patient's own words, echoed back
  'Entendi, você mencionou um problema na coluna.',
  'meu diagnóstico foi hérnia',
  // question and hypothesis disarm the diagnosis rule
  'Você tem alguma lesão ou cirurgia recente?',
  'Se for uma hérnia de disco, o fisioterapeuta monta o protocolo certo.',
  // the pilates studio talks about conditions without diagnosing anyone
  'O pilates ajuda muito quem tem lombalgia.',
  'Paciente com fratura recente precisa de liberação médica.',
  // negated instructions and the disclaimer the veto asks for
  'Não tome ibuprofeno antes da sessão sem falar com seu médico.',
  'Não posso garantir que vai curar; quem avalia é o fisioterapeuta.',
  'Sem avaliação, ninguém pode dizer se vai curar.',
  'Não precisa tomar ibuprofeno antes da sessão.',
  'Você não precisa tomar nenhum analgésico antes da aula.',
  // drug name without a use verb is information, not a prescription
  'O ibuprofeno que você comentou é assunto para o seu médico.',
  'A fisioterapia vai ajudar na sua recuperação.',
  'Garantimos que o seu horário fica reservado.',
  // Spanish
  'Usted tiene razón, ese horario no sirve.',
  '¿Tiene alguna lesión reciente?',
  'No tome ibuprofeno antes de la sesión.',
  'Eso no va a curar solo, por eso la evaluación es importante.',
  'No podemos asegurar que va a curar; quien evalúa es el fisioterapeuta.',
];

describe('detectarAfirmacaoClinica — physiotherapy/pilates (Berseba)', () => {
  it.each(bars)('bars %s: %s', (categoria, texto) => {
    expect(detectarAfirmacaoClinica(texto).categorias).toContain(categoria);
  });

  it.each(passes)('passes: %s', (texto) => {
    expect(detectarAfirmacaoClinica(texto)).toEqual({ achou: false, categorias: [] });
  });
});

describe('vetoReason — clinical_claim (Berseba)', () => {
  it('the lead timeline reads a sentence, not the gate code', () => {
    const texto = vetoReason('clinical_claim', 'clinical_claim');
    expect(texto).toContain('diagnóstico');
    expect(texto).not.toContain('"clinical_claim"');
  });
});
