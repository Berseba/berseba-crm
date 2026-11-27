/**
 * Berseba (#171, slice 3): meeting detection, every 5 minutes.
 *
 * For each organization in MEETING_DETECTION_ORG_IDS that is not stopped, one round of
 * `rodadaDeReunioes` with the organization's own model (`runModelCall`, purpose
 * `meeting_detection`: the org's default model, its AI budget, one `llm_calls` row per call).
 * One organization failing never stops the others. Nothing is booked here.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";

import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/credentials";
import { runModelCall, tool, type ModelMessage } from "@/lib/agent-engine/edge/llm/run-model-call";
import { getSkillsPool } from "@/lib/ai/skills/db";
import { fail, ok } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { env } from "@/lib/env";
import { orgsComDeteccao, respostaDoModelo, SISTEMA_DA_DETECCAO } from "@/lib/integrations/reunioes/deteccao";
import { rodadaDeReunioes, type Classificar } from "@/lib/integrations/reunioes/varredura";
import { logger } from "@/lib/logger";
import { idsDeOrgsParadas } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

function classificadorDa(organizationId: string): Classificar {
  return async (texto, sistema) => {
    const messages: ModelMessage[] = [{ role: "user", content: `Mensagem do cliente:\n${texto}` }];
    const { result } = await runModelCall(getSkillsPool(), llmEdgeConfigFromEnv(env), {
      tenantId: organizationId,
      purpose: "meeting_detection",
      system: sistema,
      messages,
      temperature: 0,
      reasoning: "none",
      maxOutputTokens: 200,
      tools: {
        informar_reuniao: tool({ inputSchema: respostaDoModelo, execute: async (args) => args }),
      },
    });
    return result.toolCalls?.find((c) => c.toolName === "informar_reuniao")?.input ?? null;
  };
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }
  const orgs = [...orgsComDeteccao()];
  if (orgs.length === 0) return ok({ rodadas: [] }, { requestId });

  const admin = createAdminClient();
  const paradas = new Set(await idsDeOrgsParadas(admin));
  const agora = new Date();
  // One deadline for the whole run: the scheduler gives the cron 120 s.
  const prazo = Date.now() + 90_000;
  const rodadas: Array<Record<string, unknown>> = [];
  for (const org of orgs) {
    if (paradas.has(org)) continue;
    try {
      const { data } = await admin.from("organizations").select("timezone").eq("id", org).maybeSingle();
      const fuso = (data as { timezone?: string } | null)?.timezone ?? "America/Sao_Paulo";
      const r = await rodadaDeReunioes(admin, org, fuso, agora, classificadorDa(org), SISTEMA_DA_DETECCAO, prazo);
      if (r.erro) logger.warn("meeting_detection: round stopped", { organization_id: org, error: r.erro });
      rodadas.push({ organization_id: org, ...r, erro: r.erro ? "sim" : undefined });
    } catch (erro) {
      logger.warn("meeting_detection: round failed", {
        organization_id: org,
        error: erro instanceof Error ? erro.message : String(erro),
      });
      rodadas.push({ organization_id: org, falhou: true });
    }
  }
  return ok({ rodadas }, { requestId });
}

export const GET = handle;
export const POST = handle;
