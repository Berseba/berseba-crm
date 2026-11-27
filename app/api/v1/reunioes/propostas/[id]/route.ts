/**
 * Berseba (#171, slice 3): POST /api/v1/reunioes/propostas/{id} — a partner books or dismisses a
 * meeting proposal (form field `acao`: `criar` | `descartar`).
 *
 * `criar` books it in the CRM agenda through upstream's own handler (`marcarAgendamentoHandler`)
 * as the clicking person (`actor.type = "user"`: a person may book outside the published slots,
 * only overlaps are refused), owned by them, on the organization's first active internal event
 * type, with the contact; upstream's push cron then writes it to that person's Google Calendar.
 * The proposal's id is the idempotency key, so a double click books once. Admin only, like the
 * screen. Always answers with a redirect back to `/app/emails`.
 */
import { type NextRequest, NextResponse } from "next/server";

import { marcarAgendamentoHandler } from "@/app/api/v1/agenda/agendamentos/_handler";
import { comIdDaRequisicao } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { deteccaoLigada } from "@/lib/integrations/reunioes/deteccao";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function voltar(parametro: string, req: NextRequest): NextResponse {
  const base = env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return comIdDaRequisicao(NextResponse.redirect(new URL(`/app/emails?${parametro}#reunioes`, base), 303), req);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
  const autorizado = await requireRole("admin", { requestId, resource: "meeting_proposals" });
  if (!autorizado.ok) return autorizado.response;
  const { user, org } = autorizado;

  const { id } = await params;
  if (!UUID.test(id) || !deteccaoLigada(org.orgId)) return voltar("reuniao=nao_encontrada", req);
  const form = await req.formData().catch(() => null);
  const acao = form?.get("acao");
  if (acao !== "criar" && acao !== "descartar") return voltar("reuniao=acao_invalida", req);

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("meeting_proposals")
    .select("id, status, contact_id, starts_at, duration_minutes, title, excerpt, source")
    .eq("organization_id", org.orgId)
    .eq("id", id)
    .maybeSingle();
  const proposta = data as {
    id: string;
    status: string;
    contact_id: string | null;
    starts_at: string | null;
    duration_minutes: number | null;
    title: string | null;
    excerpt: string | null;
    source: string;
  } | null;
  if (error || !proposta || proposta.status !== "proposta") return voltar("reuniao=nao_encontrada", req);

  const decidir = (campos: Record<string, unknown>) =>
    admin
      .from("meeting_proposals")
      .update({ ...campos, decided_by: user.id, decided_at: new Date().toISOString() })
      .eq("organization_id", org.orgId)
      .eq("id", id)
      .eq("status", "proposta");

  if (acao === "descartar") {
    await decidir({ status: "descartada" });
    await audit({ action: "reunioes.proposta_descartada", organizationId: org.orgId, metadata: { proposta_id: id } });
    return voltar("reuniao=descartada", req);
  }

  if (!proposta.starts_at) return voltar("reuniao=sem_horario", req);
  // The event type: an active, internal, non-service one; the one with slug `reuniao` when the
  // organization has it, else the oldest. Its own settings apply as in any booking
  // (confirmation, reminders to the contact), so the organization decides those on the type.
  const { data: tipos } = await admin
    .from("calendar_event_types")
    .select("id, slug, created_at")
    .eq("organization_id", org.orgId)
    .eq("is_active", true)
    .eq("service_enabled", false)
    .is("external_provider", null)
    .order("created_at", { ascending: true })
    .limit(50);
  const lista = (tipos as Array<{ id: string; slug: string }> | null) ?? [];
  const tipo = lista.find((x) => x.slug === "reuniao") ?? lista[0];
  if (!tipo) return voltar("reuniao=sem_tipo", req);

  let agendamentoId: string | null = null;
  try {
    const supabase = await createClient();
    const r = await marcarAgendamentoHandler(
      supabase,
      { organization_id: org.orgId, actor: { type: "user", id: user.id, role: org.role }, requestId, idempotencyKey: id },
      {
        event_type_id: tipo.id,
        starts_at: proposta.starts_at,
        owner_user_id: user.id,
        ...(proposta.contact_id ? { contact_id: proposta.contact_id } : {}),
        ...(proposta.title ? { title: proposta.title } : {}),
        ...(proposta.duration_minutes ? { duration_minutes: proposta.duration_minutes } : {}),
        ...(proposta.excerpt ? { description: proposta.excerpt } : {}),
      },
    );
    agendamentoId = typeof r.id === "string" ? r.id : null;
  } catch (erro) {
    const codigo = erro instanceof ApiError ? erro.code : "internal_error";
    await audit({
      action: "reunioes.proposta_falhou",
      organizationId: org.orgId,
      metadata: { proposta_id: id, codigo },
    });
    return voltar(`reuniao=falhou&codigo=${encodeURIComponent(codigo)}`, req);
  }

  // The appointment exists now: the proposal says so even if someone dismissed it meanwhile.
  await admin
    .from("meeting_proposals")
    .update({ status: "criada", appointment_id: agendamentoId, decided_by: user.id, decided_at: new Date().toISOString() })
    .eq("organization_id", org.orgId)
    .eq("id", id);
  // Other open proposals of the same contact for the same time (the request and then the
  // confirmation) are the same meeting: closed with it.
  if (proposta.contact_id) {
    await admin
      .from("meeting_proposals")
      .update({ status: "descartada", decided_by: user.id, decided_at: new Date().toISOString() })
      .eq("organization_id", org.orgId)
      .eq("contact_id", proposta.contact_id)
      .eq("status", "proposta")
      .eq("starts_at", proposta.starts_at)
      .neq("id", id);
  }
  await audit({
    action: "reunioes.proposta_criada",
    organizationId: org.orgId,
    metadata: { proposta_id: id, appointment_id: agendamentoId },
  });
  return voltar("reuniao=criada", req);
}
