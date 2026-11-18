import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/leads/[id]/touches — Berseba (migration 9005).
 *
 * Records one touch on the lead: `{ channel: email|linkedin|whatsapp|call, note? }`
 * becomes a `touch` line on the lead timeline, which `analytics.v1_contagem_dia`
 * counts for the weekly goals.
 *
 * - `agent`+, like the other writes from the lead dossier (tasks, cold call
 *   result); the temporary support session only reads (`requireSupportWrite`).
 * - The organization comes from the session, never from the body; the lead is
 *   read with that filter, so another organization's lead is a 404.
 * - Unlike the fire-and-forget timeline lines that describe another mutation,
 *   here the line IS the mutation: a failed insert answers 500.
 * - The audit row carries the channel only. The note is free text and stays on
 *   the timeline.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { touchReason, touchSchema } from "@/lib/leads/touch";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const { id: leadId } = await ctx.params;
  if (!UUID.test(leadId)) return fail("not_found", t("Lead não encontrado."), 404, { requestId });

  const lido = touchSchema.safeParse(await req.json().catch(() => null));
  if (!lido.success) {
    return fail("unprocessable_entity", t("Escolha o canal do toque."), 422, { requestId });
  }

  const supabase = await createClient();
  const { data: lead, error } = await supabase
    .from("crm_leads")
    .select("id, contact_id")
    .eq("id", leadId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!lead) return fail("not_found", t("Lead não encontrado."), 404, { requestId });

  const gravada = await emitLeadActivity(supabase, {
    organizationId: orgId,
    leadId,
    contactId: (lead as { contact_id: string | null }).contact_id,
    type: "touch",
    sourceModule: "crm",
    actor: { type: "user", id: authz.user.id },
    reason: touchReason(lido.data),
    payload: { channel: lido.data.channel },
  });
  if (!gravada.ok) {
    return fail("internal_error", t("Não foi possível registrar o toque."), 500, { requestId });
  }

  void audit({
    action: "lead.touch_recorded",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "crm_leads",
    resourceId: leadId,
    requestId,
    metadata: { channel: lido.data.channel, has_note: Boolean(lido.data.note) },
  });
  return ok({ channel: lido.data.channel }, { requestId, status: 201 });
}
