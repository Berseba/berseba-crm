/**
 * Flywheel vivo (Fase 2C/4B) — judge + distiller sobre turnos REAIS, como
 * módulo reutilizável: o script one-shot (scripts/flywheel-judge-live.ts) e o
 * loop agendado do worker chamam o MESMO runFlywheelOnce. Gate humano
 * inegociável: propostas só viram comportamento quando o dono publica na tela.
 */
import type pg from 'pg';

import { extrairJsonDoTexto } from '@/lib/agent-engine/texto/extrair-json-do-texto';

import { runModelCall, type LlmEdgeConfig } from '../edge/llm/run-model-call';
import type { Logger } from '../obs/logger';
import { aggregateFollowupOutcomes, type FlowOutcomeStat } from '../../followup/outcome-stats';

// Os dois pontos do flywheel NÃO fixam modelo aqui. Fixavam `claude-haiku-4-5`,
// e um id de modelo só é válido no vocabulário do provedor que a instalação usa:
// numa VPS com a org apontada para OpenRouter, esse id literal voltava 400
// `claude-haiku-4-5 is not a valid model ID` e a rodada agendada morria a cada
// disparo (medido em produção em 2026-09-05). Sem `model`, cada ponto resolve
// pela cadeia normal — escolha do painel de provedores, senão o padrão da
// organização —, que é a mesma que faz todos os outros pontos funcionarem na
// instalação. Onde não houver nenhum dos dois, o erro passa a ser o acionável
// "modelo LLM não definido — configure o ponto no painel de provedores", em vez
// de um 400 do provedor.
const DIMENSION = 'memory_hygiene';
const DATASET = 'live';

interface TurnRow {
  job_id: string;
  organization_id: string;
  contact_id: string;
}

interface TraceMaterial {
  transcript: string;
  notesNow: string;
  rollingSummary: string;
}

// The judge reads the contact's CURRENT conversation (buildMaterial), not the
// state at turn time, so a stale turn says nothing about that turn. The window
// also keeps the first run after an upgrade from backfilling the whole history.
export const LOOKBACK_DAYS = 7;

/**
 * Turns still waiting for a verdict, at most `limitPerOrg` per organization.
 *
 * - Per org: a global "10 most recent" let one busy org take every slot, and the
 *   other orgs were never judged.
 * - Latest turn per contact: the material is per contact, so two turns of the
 *   same contact in one run were the same judge call twice. Once the latest turn
 *   has a verdict, the contact is skipped until it has a newer turn.
 * - Skips judged turns BEFORE the LLM call. The `on conflict do nothing` on the
 *   insert only deduplicated the row, after the judge call was already paid, so
 *   a quiet installation re-judged the same turns on every run.
 */
export async function collectPendingTurns(pool: pg.Pool, limitPerOrg: number): Promise<TurnRow[]> {
  const { rows } = await pool.query<TurnRow>(
    `with latest_per_contact as (
       select distinct on (j.organization_id, j.contact_id)
              j.id, j.organization_id, j.contact_id, j.created_at
       from job_queue j
       where j.kind = 'inbound_turn' and j.status = 'done' and j.contact_id is not null
         and j.created_at > now() - make_interval(days => $4)
         and exists (
           select 1 from llm_calls c
           where c.organization_id = j.organization_id and c.purpose = 'agent_turn'
             and c.created_at > now() - make_interval(days => $4) and c.job_id = j.id
         )
       order by j.organization_id, j.contact_id, j.created_at desc
     ), pending as (
       select l.id, l.organization_id, l.contact_id,
              row_number() over (partition by l.organization_id order by l.created_at desc) as rank_in_org
       from latest_per_contact l
       where not exists (
         select 1 from flywheel_judge_verdicts v
         where v.organization_id = l.organization_id
           and v.dataset = $1 and v.trace_id = l.id::text and v.dimension = $2
       )
     )
     select id as job_id, organization_id, contact_id
     from pending
     where rank_in_org <= $3
     order by organization_id, rank_in_org`,
    [DATASET, DIMENSION, limitPerOrg, LOOKBACK_DAYS],
  );
  return rows;
}

async function buildMaterial(pool: pg.Pool, turn: TurnRow): Promise<TraceMaterial> {
  const { rows: msgs } = await pool.query<{ direction: string; body: string | null }>(
    `select direction, body from messages
     where organization_id = $1 and contact_id = $2 and body is not null
     order by sent_at desc limit 12`,
    [turn.organization_id, turn.contact_id],
  );
  const transcript = msgs
    .reverse()
    .map((m) => `${m.direction === 'inbound' ? 'LEAD' : 'AGENTE'}: ${m.body}`)
    .join('\n');

  const { rows: notes } = await pool.query<{ headline: string }>(
    `select headline from lead_notes where organization_id = $1 and contact_id = $2 order by created_at`,
    [turn.organization_id, turn.contact_id],
  );
  const notesNow = notes.length > 0 ? notes.map((n) => `- ${n.headline}`).join('\n') : '(nenhuma nota durável)';

  const { rows: cp } = await pool.query<{ rolling_summary: string }>(
    `select rolling_summary from lead_checkpoints
     where organization_id = $1 and contact_id = $2 order by seq desc limit 1`,
    [turn.organization_id, turn.contact_id],
  );
  return { transcript, notesNow, rollingSummary: cp[0]?.rolling_summary ?? '(sem checkpoint)' };
}

/** yes = higiene ok; no = fato durável perdido/mal consolidado; unknown = indecidível. */
function judgePrompt(m: TraceMaterial, optionOrder: 'yes_first' | 'no_first'): string {
  const options =
    optionOrder === 'yes_first'
      ? '"yes" (higiene de memória OK) | "no" (fato durável perdido) | "unknown"'
      : '"no" (fato durável perdido) | "yes" (higiene de memória OK) | "unknown"';
  return [
    'Você é um JUIZ de qualidade de memória de um agente SDR de WhatsApp. Avalie APENAS a dimensão',
    `"${DIMENSION}": o agente preservou nas NOTAS DURÁVEIS os fatos duráveis do lead que a conversa`,
    'revelou? Fatos duráveis = identidade/negócio/necessidade/canal (ex.: nome, tipo de loja, produto).',
    'Regra: se um fato durável aparece no TRANSCRIPT ou no RESUMO mas NÃO está nas notas duráveis',
    '(porque nunca foi salvo ou porque uma consolidação o apagou), o veredito é "no".',
    '',
    '=== TRANSCRIPT (recente) ===',
    m.transcript,
    '',
    '=== RESUMO ACUMULADO (checkpoint) ===',
    m.rollingSummary,
    '',
    '=== NOTAS DURÁVEIS (estado atual) ===',
    m.notesNow,
    '',
    `Responda SOMENTE JSON: {"verdict": ${options}, "missing_facts": string[] (curtos, sem dados pessoais completos)}`,
  ].join('\n');
}

function distillerPrompt(missingFacts: string[]): string {
  return [
    'Você melhora PLAYBOOKS de agentes SDR por DELTAS mínimos. Um juiz constatou falha de higiene de',
    `memória em conversa real: fatos duráveis fora das notas do lead (${missingFacts.join('; ')}).`,
    'Causa raiz típica: o agente consolida notas com "supersedes" apagando fatos de OUTRO assunto.',
    'Proponha UM único bullet de playbook, em pt-BR, imperativo, ≤3 linhas, que previna essa classe',
    'de falha sem proibir consolidação legítima. NÃO cite dados do lead.',
    'Decida também o ESCOPO do aprendizado: "org" quando vale para TODO atendimento da organização',
    '(política, tom de voz, fato do negócio — ex.: "a loja não vende aos domingos"); "agent" quando é',
    'específico do comportamento deste agente.',
    'Responda SOMENTE JSON: {"content": string, "scope": "agent" | "org"}',
  ].join('\n');
}

type JudgeOutput = {
  verdict: 'yes' | 'no' | 'unknown';
  missingFacts: string[];
  /** Set when the call succeeded but its answer was unusable. */
  error?: 'unparsable' | 'invalid_verdict';
};

/** An unusable answer is a TURN-level outcome, never a throw: it is recorded as
 *  `unknown` so the turn is not picked again. Throwing used to stop the org's
 *  round with no verdict row, and the next run paid the judge for the same turn
 *  again, forever, while every turn ranked after it stayed unjudged. */
function readJudgeOutput(text: string): JudgeOutput {
  const value = extrairJsonDoTexto(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { verdict: 'unknown', missingFacts: [], error: 'unparsable' };
  }
  const { verdict, missing_facts: missingFacts } = value as { verdict?: unknown; missing_facts?: unknown };
  const facts = Array.isArray(missingFacts) ? missingFacts.filter((f): f is string => typeof f === 'string') : [];
  if (verdict === 'yes' || verdict === 'no' || verdict === 'unknown') return { verdict, missingFacts: facts };
  return { verdict: 'unknown', missingFacts: [], error: 'invalid_verdict' };
}

/** Null when the distiller's answer has no usable `content`. */
function readDistillerOutput(text: string): { content: string; scope?: string } | null {
  const value = extrairJsonDoTexto(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { content, scope } = value as { content?: unknown; scope?: unknown };
  if (typeof content !== 'string' || content.trim() === '') return null;
  return { content, scope: typeof scope === 'string' ? scope : undefined };
}

// One run at a time across the installation: the worker loop and a manual
// `pnpm flywheel:judge` collected the same pending turns and both paid the judge.
// The verdict's `on conflict do nothing` protected the row, not the spend.
const RUN_LOCK_KEY = 'flywheel:live_run';


export interface FlywheelRunResult {
  runId: string;
  judged: number;
  proposals: number;
  /** Orgs whose round stopped on a model-call error (budget, model, provider,
   *  credential). The other orgs still run; the failed org's turns stay pending.
   *  An unusable ANSWER is not a failure: it is recorded as `unknown`. */
  failedOrgs: number;
  /** True when another run held the lock: nothing was collected or paid. */
  skipped: boolean;
  /** Task 8.2 — outcomes de follow-up (converted/replied/exhausted/opted_out/
   *  handoff/in_flight) por pointer+version, por org tocada nesta rodada
   *  (via os turnos coletados). Fecha o loop: o flywheel passa a enxergar
   *  quais fluxos convertem, não só a higiene de memória do turno. */
  followupOutcomes: Array<{ organization_id: string; stats: FlowOutcomeStat[] }>;
}

export async function runFlywheelOnce(
  pool: pg.Pool,
  llmCfg: LlmEdgeConfig,
  /**
   * `limit` is PER ORGANIZATION (see collectPendingTurns). Berseba: `janelaMs`
   * (upstream's window) is not applied: the per-org query keeps LOOKBACK_DAYS.
   */
  opts: { limit: number; log: Logger; janelaMs?: number },
): Promise<FlywheelRunResult> {
  const runId = crypto.randomUUID();
  const lockClient = await pool.connect();
  let locked = false;
  try {
    const { rows } = await lockClient.query<{ locked: boolean }>(
      'select pg_try_advisory_lock(hashtextextended($1, 0)) as locked',
      [RUN_LOCK_KEY],
    );
    locked = rows[0]?.locked === true;
    if (!locked) {
      opts.log.info('flywheel: another run holds the lock; skipping', { run_id: runId });
      return { runId, judged: 0, proposals: 0, failedOrgs: 0, skipped: true, followupOutcomes: [] };
    }
    return await runLocked(pool, llmCfg, opts, runId);
  } finally {
    try {
      if (locked) await lockClient.query('select pg_advisory_unlock(hashtextextended($1, 0))', [RUN_LOCK_KEY]);
    } finally {
      lockClient.release();
    }
  }
}

async function runLocked(
  pool: pg.Pool,
  llmCfg: LlmEdgeConfig,
  opts: { limit: number; log: Logger },
  runId: string,
): Promise<FlywheelRunResult> {
  const { limit, log } = opts;
  const turns = await collectPendingTurns(pool, limit);
  log.info('flywheel: turnos reais coletados', { run_id: runId, turns: turns.length });
  let judged = 0;
  let proposals = 0;
  let failedOrgs = 0;

  const turnsByOrg = new Map<string, TurnRow[]>();
  for (const turn of turns) {
    const orgTurns = turnsByOrg.get(turn.organization_id) ?? [];
    orgTurns.push(turn);
    turnsByOrg.set(turn.organization_id, orgTurns);
  }

  // One failure boundary per org: an org out of budget, without a model or with
  // a provider error used to abort the whole run, so every org after it in the
  // batch was never judged either. Only a THROWN model call reaches this catch:
  // it is not safe to pin on one turn (a 400 for an invalid model id is an org
  // problem), so the org stops and its turns are retried next run.
  for (const [orgId, orgTurns] of turnsByOrg) {
    try {
      for (const turn of orgTurns) {
        const outcome = await judgeTurn(pool, llmCfg, turn, runId, log);
        if (outcome.judged) judged += 1;
        if (outcome.proposal) proposals += 1;
      }
    } catch (err) {
      failedOrgs += 1;
      log.error('flywheel: org round failed; other orgs continue', {
        run_id: runId,
        organization_id: orgId,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
  }

  // Task 8.2 — o sinal (followup_enrollments.outcome) já existe (Ondas 4/5);
  // aqui só agregamos por org tocada nesta rodada (via os turnos coletados
  // acima) e logamos, pra a rodada do flywheel surfacear "flow X converte a
  // N%" junto do resto. Sem tabela nova: nenhum destino de persistência
  // óbvio existe pra artefatos de rodada do flywheel (ver flywheel_judge_verdicts/
  // flywheel_distiller_proposals no baseline) — log + retorno no resultado é
  // suficiente por instrução do brief.
  const followupOutcomes: FlywheelRunResult['followupOutcomes'] = [];
  for (const orgId of turnsByOrg.keys()) {
    const stats = await aggregateFollowupOutcomes(pool, orgId);
    if (stats.length === 0) continue;
    followupOutcomes.push({ organization_id: orgId, stats });
    log.info('flywheel: outcomes de follow-up por fluxo', { run_id: runId, organization_id: orgId, stats });
  }

  return { runId, judged, proposals, failedOrgs, skipped: false, followupOutcomes };
}

/** Judge one turn and, on "no", distill one proposal. Every write and every LLM
 *  call carries the turn's own organization_id: cost, BYOK key and budget are
 *  resolved for that org inside runModelCall. */
async function judgeTurn(
  pool: pg.Pool,
  llmCfg: LlmEdgeConfig,
  turn: TurnRow,
  runId: string,
  log: Logger,
): Promise<{ judged: boolean; proposal: boolean }> {
  const material = await buildMaterial(pool, turn);
  const optionOrder = parseInt(turn.job_id.slice(0, 8), 16) % 2 === 0 ? 'yes_first' : 'no_first';

  const judgedCall = await runModelCall(
    pool,
    llmCfg,
    {
      tenantId: turn.organization_id,
      leadId: turn.contact_id,
      jobId: turn.job_id,
      purpose: 'flywheel_judge',
      messages: [{ role: 'user', content: judgePrompt(material, optionOrder) }],
    },
    { log },
  );
  const judgeOutput = readJudgeOutput(judgedCall.result.text);
  const verdictValue = judgeOutput.verdict;
  if (judgeOutput.error) {
    log.warn('flywheel: unusable judge answer recorded as unknown', {
      job_id: turn.job_id,
      error: judgeOutput.error,
    });
  }

  const { rowCount } = await pool.query(
    `insert into flywheel_judge_verdicts
       (organization_id, dataset, trace_id, dimension, verdict, option_order, judge_family, model, provenance, run_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (dataset, trace_id, dimension) do nothing`,
    [
      turn.organization_id,
      DATASET,
      turn.job_id,
      DIMENSION,
      verdictValue,
      optionOrder,
      judgedCall.provider,
      judgedCall.model,
      JSON.stringify({
        source: 'live_turn',
        job_id: turn.job_id,
        contact_id: turn.contact_id,
        ...(judgeOutput.error ? { error: judgeOutput.error } : {}),
      }),
      runId,
    ],
  );
  const inserted = (rowCount ?? 0) > 0;
  log.info('flywheel: veredito gravado', { job_id: turn.job_id, verdict: verdictValue, inserted });

  if (verdictValue === 'no' && inserted) {
    const distilled = await runModelCall(
      pool,
      llmCfg,
      {
        tenantId: turn.organization_id,
        leadId: turn.contact_id,
        jobId: turn.job_id,
        purpose: 'flywheel_distiller',
        messages: [{ role: 'user', content: distillerPrompt(judgeOutput.missingFacts) }],
      },
      { log },
    );
    const proposal = readDistillerOutput(distilled.result.text);
    if (proposal === null) {
      // The verdict is already saved; losing this one proposal must not stop the
      // org's round.
      log.warn('flywheel: unusable distiller answer; no proposal for this turn', { job_id: turn.job_id });
      return { judged: inserted, proposal: false };
    }
    const isOrg = proposal.scope?.toLowerCase().trim() === 'org';
    await pool.query(
      `insert into flywheel_distiller_proposals
         (organization_id, run_id, dataset, type, target, content, evidence)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        turn.organization_id,
        runId,
        DATASET,
        isOrg ? 'org_memory_entry' : 'playbook_bullet',
        isOrg ? 'org' : 'tenant',
        proposal.content,
        JSON.stringify({ trace_ids: [turn.job_id], dimension: DIMENSION, verdict_run_id: runId }),
      ],
    );
    log.info('flywheel: proposta do distiller gravada (gate humano pendente)', { job_id: turn.job_id });
    return { judged: inserted, proposal: true };
  }
  return { judged: inserted, proposal: false };
}

/** Loop agendado do flywheel (4B) — intervalo por knob; erro nunca derruba o worker. */
export async function runFlywheelLoop(
  pool: pg.Pool,
  llmCfg: LlmEdgeConfig,
  opts: { intervalMs: number; limit: number; log: Logger },
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    // dorme PRIMEIRO: no boot os turnos recentes já foram julgados pela rodada
    // anterior (o `not exists` de `collectRecentTurns`), e subir o worker não
    // deve custar LLM.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, opts.intervalMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    if (signal.aborted) return;
    try {
      // 2× o intervalo: a rodada cobre o que entrou desde a anterior, com folga
      // para um atraso ou um reinício do worker, e nunca o histórico inteiro.
      const result = await runFlywheelOnce(pool, llmCfg, {
        limit: opts.limit,
        log: opts.log,
        janelaMs: 2 * opts.intervalMs,
      });
      opts.log.info('flywheel: rodada agendada concluída', result as unknown as Record<string, unknown>);
    } catch (err) {
      opts.log.error('flywheel: rodada agendada falhou', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
  }
}
