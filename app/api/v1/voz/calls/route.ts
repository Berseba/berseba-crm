/**
 * Berseba: "Ligar com a Bia" (Berseba/berseba issue #232). From the lead's card, a person asks
 * Voz's agent to call the lead's contact over WhatsApp; the report comes back to the same card
 * through `POST /api/v1/voz/call-ended`.
 *
 * GET says whether the button exists for this organization (`VOZ_API_ORG_IDS`); POST asks for the
 * call. Session only, at least `agent`, like the Cold Call result. The contact rules are the voice
 * route's (`motivoParaNaoLigar`): a blocked, personal or anonymized contact gets no call. The rest
 * (opt-out list, one call per number, the line's daily limit, the paused agent) is Voz's, and its
 * answer comes back as a code the button turns into a sentence.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { motivoParaNaoLigar } from "@/lib/cold-call/regras";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { MENSAGEM_DO_PEDIDO, pedirLigacaoNaVoz } from "@/lib/integrations/voz/client";
import { vozConfigFor } from "@/lib/integrations/voz/config";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const pedidoSchema = z.object({ lead_id: z.string().uuid() });

/** Voz's refusals: which HTTP status the button gets. */
const STATUS_DO_CODIGO: Record<keyof typeof MENSAGEM_DO_PEDIDO, number> = {
  opted_out: 409,
  in_progress: 409,
  suspended: 423,
  daily_limit: 429,
  unauthorized: 502,
  no_line: 502,
  bad_phone: 422,
  unavailable: 503,
};

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  return ok({ ativo: vozConfigFor(authz.org.orgId) !== null }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const config = vozConfigFor(orgId);
  if (!config) return fail("not_found", t("A Bia não está disponível nesta organização."), 404, { requestId });

  const lido = pedidoSchema.safeParse(await req.json().catch(() => null));
  if (!lido.success) return fail("unprocessable_entity", t("Lead não encontrado."), 422, { requestId });
  const leadId = lido.data.lead_id;

  const supabase = await createClient();
  const { data: lead, error } = await supabase
    .from("crm_leads")
    .select("id, contact_id")
    .eq("id", leadId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!lead) return fail("not_found", t("Lead não encontrado."), 404, { requestId });
  if (!lead.contact_id) {
    return fail("contact_without_phone", t("Este negócio não tem contato com telefone."), 422, { requestId });
  }

  const { data: contato, error: erroContato } = await supabase
    .from("contacts")
    .select("phone_number, is_blocked, is_personal, is_anonymized")
    .eq("id", lead.contact_id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (erroContato) return fail("internal_error", erroContato.message, 500, { requestId });
  const motivo = motivoParaNaoLigar(contato);
  if (motivo === "bloqueado") return fail("forbidden", t("Contato bloqueou o atendimento."), 403, { requestId });
  if (motivo === "pessoal") return fail("forbidden", t("Contato marcado como pessoal."), 403, { requestId });
  if (motivo === "anonimizado") {
    return fail("contact_anonymized", t("Contato anonimizado não pode ser chamado."), 422, { requestId });
  }
  const telefone = (contato?.phone_number as string | null | undefined)?.trim();
  if (!telefone) {
    return fail("contact_without_phone", t("Este negócio não tem contato com telefone."), 422, { requestId });
  }

  const pedido = await pedirLigacaoNaVoz(config, { phone: telefone, leadId });
  void audit({
    action: "voz.call_requested",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "crm_leads",
    resourceId: leadId,
    requestId,
    metadata: pedido.ok ? { voz_call_id: pedido.callId } : { refused: pedido.codigo },
  });
  if (!pedido.ok) {
    return fail(pedido.codigo, t(MENSAGEM_DO_PEDIDO[pedido.codigo]), STATUS_DO_CODIGO[pedido.codigo], {
      requestId,
    });
  }
  return ok({ call_id: pedido.callId }, { requestId });
}
