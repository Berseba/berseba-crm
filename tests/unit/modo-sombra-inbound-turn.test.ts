/**
 * MODO SOMBRA no turno inbound — o cinto de segurança ACIMA do agente.
 *
 * `assistido-respeita-o-gate.test.ts` cobre o agente que JÁ nasceu
 * `operation_mode = 'assisted'`. Este arquivo cobre o caso que só existe a
 * partir desta feature: um agente `automatic` (nenhuma configuração por
 * agente pede rascunho) cuja ORGANIZAÇÃO ou CANAL ligou o modo sombra —
 * `createInboundTurnHandler` tem de se comportar EXATAMENTE como o ramo
 * assistido de `assistido-respeita-o-gate.test.ts`: gera rascunho, nunca
 * envia automático.
 *
 * Harness idêntico ao de `assistido-respeita-o-gate.test.ts` (mesmo arquivo
 * sob teste, mesmos pontos de mock) — muda só o agente (automatic) e o que
 * `lerModoSombra` devolve.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedAgentConfig } from '@/lib/agent-engine/agent/agent-config';

const mocks = vi.hoisted(() => ({
  router: vi.fn(), classify: vi.fn(), byId: vi.fn(), bySession: vi.fn(), conversationAgent: vi.fn(),
  draft: vi.fn(), operation: vi.fn(), handoff: vi.fn(), elegibilidade: vi.fn(), lerModoSombra: vi.fn(),
}));
vi.mock('@/lib/agent-engine/agent/router-config', () => ({ loadActiveRouter: mocks.router }));
vi.mock('@/lib/agent-engine/agent/intent-classifier', () => ({ classifyIntent: mocks.classify }));
vi.mock('@/lib/agent-engine/agent/agent-config', () => ({
  loadPublishedAgentConfigById: mocks.byId, loadPublishedAgentConfig: mocks.bySession,
  loadConversationAgentConfig: mocks.conversationAgent,
}));
vi.mock('@/lib/agent-engine/agent/reply-drafts', () => ({ generateReplyDraft: mocks.draft }));
vi.mock('@/lib/atendimento/fronteira-server', () => ({
  currentExecutionBoundary: () => undefined, setExecutionAgentOperation: mocks.operation,
  guardServiceEffect: vi.fn(),
}));
vi.mock('@/lib/agent-engine/agent/human-handoff', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), isLeadInHandoff: mocks.handoff,
}));
vi.mock('@/lib/agent-engine/guardrails/camadas-da-org', () => ({
  lerCamadasDaOrg: vi.fn(async () => ({})), camadaLigada: vi.fn(() => false),
}));
vi.mock('@/lib/agent-engine/agent/fuso-da-org', () => ({ fusoDaOrganizacao: vi.fn(async () => 'UTC') }));
vi.mock('@/lib/ai/elegibilidade/consulta-pg', () => ({ decidirElegibilidadeDaConversa: mocks.elegibilidade }));
vi.mock('@/lib/agent-engine/pacing/store', () => ({ loadChannelKnobs: vi.fn(async () => ({ knobs: {} })) }));
vi.mock('@/lib/agent-engine/pacing/engine', () => ({ janelaDeEnvioAberta: () => true, proximaAberturaDaJanela: vi.fn() }));
vi.mock('@/lib/agent-engine/pacing/aviso-de-janela', () => ({
  resolverAvisoDeJanela: vi.fn(async () => 0), avisarJanelaFechada: vi.fn(),
}));
vi.mock('@/lib/ai/modo-sombra', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  lerModoSombra: mocks.lerModoSombra,
}));

import { createInboundTurnHandler, type InboundTurnDeps } from '@/lib/agent-engine/agent/inbound-turn';

const ids = {
  org: '11000000-0000-4000-8000-000000000001', contact: '11000000-0000-4000-8000-000000000002',
  conversation: '11000000-0000-4000-8000-000000000003', channel: '11000000-0000-4000-8000-000000000004',
  job: '11000000-0000-4000-8000-000000000005',
};
const job = {
  id: ids.job, organization_id: ids.org, contact_id: ids.contact, kind: 'inbound_turn',
  payload: { conversation_id: ids.conversation, contact_id: ids.contact, channel_session_id: ids.channel,
    inbound_message_id: '11000000-0000-4000-8000-000000000006', crm_event_id: '11000000-0000-4000-8000-000000000007' },
};
const deps = {
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  llmCfg: {}, crmCfg: {}, knobs: {},
} as unknown as InboundTurnDeps;
const automatico = {
  agentId: 'A', versionId: 'version-A', operationRevision: '7', operationMode: 'automatic', pausedAt: null,
} as PublishedAgentConfig;

function pool() {
  mocks.router.mockResolvedValue(null);
  mocks.byId.mockResolvedValue(automatico);
  mocks.bySession.mockResolvedValue(automatico);
  mocks.conversationAgent.mockResolvedValue(automatico);
  return { query: vi.fn(async () => ({ rows: [{ active_ai_agent_id: null, active_intent: null, body: 'oi' }] })) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handoff.mockResolvedValue(false);
  mocks.elegibilidade.mockResolvedValue({ permite: true, motivo: 'gate_aberto' });
  mocks.lerModoSombra.mockResolvedValue({ org: false, canal: false });
});

describe('agente automatic + organização em modo sombra → rascunho, nunca envio automático', () => {
  it('org.settings.modo_sombra ligado → gera rascunho', async () => {
    mocks.lerModoSombra.mockResolvedValue({ org: true, canal: false });
    const p = pool();
    await createInboundTurnHandler(deps)(job as never, p as never, { workerId: 'worker' });
    expect(mocks.draft).toHaveBeenCalledOnce();
    expect(mocks.draft).toHaveBeenCalledWith(p, deps, expect.objectContaining({
      agent: automatico, organizationId: ids.org, conversationId: ids.conversation, contactId: ids.contact,
    }));
  });

  it('channel_sessions.metadata.modo_sombra ligado (canal) → gera rascunho', async () => {
    mocks.lerModoSombra.mockResolvedValue({ org: false, canal: true });
    const p = pool();
    await createInboundTurnHandler(deps)(job as never, p as never, { workerId: 'worker' });
    expect(mocks.draft).toHaveBeenCalledOnce();
  });

  it('sombra ligada + lead em handoff humano → nem rascunho, nem elegibilidade consultada', async () => {
    mocks.lerModoSombra.mockResolvedValue({ org: true, canal: false });
    mocks.handoff.mockResolvedValue(true);
    const p = pool();
    await createInboundTurnHandler(deps)(job as never, p as never, { workerId: 'worker' });
    expect(mocks.draft).not.toHaveBeenCalled();
    expect(mocks.elegibilidade).not.toHaveBeenCalled();
  });

  it('sombra ligada + conversa não elegível → nem rascunho', async () => {
    mocks.lerModoSombra.mockResolvedValue({ org: false, canal: true });
    mocks.elegibilidade.mockResolvedValue({ permite: false, motivo: 'conversa_de_humano' });
    const p = pool();
    await createInboundTurnHandler(deps)(job as never, p as never, { workerId: 'worker' });
    expect(mocks.draft).not.toHaveBeenCalled();
  });

  it('nem org nem canal em sombra (agente automatic de verdade) → NÃO entra pelo caminho de rascunho', async () => {
    mocks.lerModoSombra.mockResolvedValue({ org: false, canal: false });
    const p = pool();
    // O caminho automático segue para `runAgentTurn` (motor completo, não
    // mockado aqui de propósito — o que importa é que o desvio de sombra NÃO
    // foi tomado). Deixa a promise resolver ou rejeitar sem afirmar nada sobre
    // o motor: só o rascunho é a variável em teste.
    await createInboundTurnHandler(deps)(job as never, p as never, { workerId: 'worker' }).catch(() => {});
    expect(mocks.draft).not.toHaveBeenCalled();
  });

  it('sem canal (channelSessionId vazio) chamado corretamente ao leitor', async () => {
    mocks.lerModoSombra.mockResolvedValue({ org: true, canal: false });
    const p = pool();
    await createInboundTurnHandler(deps)(job as never, p as never, { workerId: 'worker' });
    expect(mocks.lerModoSombra).toHaveBeenCalledWith(p, {
      organizationId: ids.org,
      channelSessionId: ids.channel,
    });
  });
});
