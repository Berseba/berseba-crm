/**
 * GET  /api/v1/channel-sessions/[id]/modo-sombra — lê
 *      `channel_sessions.metadata.modo_sombra`.
 * PATCH /api/v1/channel-sessions/[id]/modo-sombra — liga/desliga (manager+).
 *
 * Irmão, por canal, de `settings/modo-sombra` (organização inteira, admin) e
 * vizinho de `ai-access` (mesmo canal, mesmo lugar na tela — ver
 * `ChannelAiAccess.tsx`). Rota SEPARADA de `ai-access` de propósito: aquela é
 * admin-only para TODOS os campos que protege (números de teste), e o modo
 * sombra por canal é intencionalmente mais permissivo — `manager`, o mesmo
 * patamar de `settings/routing` — porque é reversível com um clique e não
 * expõe dado nenhum, só muda "a IA deste canal sugere, não envia".
 *
 * `organization_id` de fonte confiável (`requireRole`); admin client + filtro
 * manual, como toda escrita de tabela tenant-aware por service role.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

const modoSombraPatchSchema = z.object({ modo_sombra: z.boolean() });

export async function GET(_req: NextRequest, { params }: Context): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "channel_sessions", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "Canal inválido.", 422, { requestId });

  const { data, error } = await createAdminClient()
    .from("channel_sessions")
    .select("metadata")
    .eq("organization_id", auth.org.orgId)
    .eq("id", id)
    .is("archived_at", null)
    .maybeSingle();
  if (error) return fail("internal_error", "Não foi possível carregar o modo sombra.", 500, { requestId });
  if (!data) return fail("not_found", "Canal não encontrado.", 404, { requestId });

  const metadata = (data.metadata as Record<string, unknown> | null) ?? {};
  return ok({ modo_sombra: metadata.modo_sombra === true }, { requestId });
}

export async function PATCH(req: NextRequest, { params }: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "channel_sessions", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "Canal inválido.", 422, { requestId });

  const parsed = modoSombraPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Envie { modo_sombra: boolean }.", 422, { requestId });

  const admin = createAdminClient();
  const { data: current, error: readErr } = await admin
    .from("channel_sessions")
    .select("metadata")
    .eq("organization_id", auth.org.orgId)
    .eq("id", id)
    .is("archived_at", null)
    .maybeSingle();
  if (readErr) return fail("internal_error", readErr.message, 500, { requestId });
  if (!current) return fail("not_found", "Canal não encontrado.", 404, { requestId });

  const currentMetadata = (current.metadata as Record<string, unknown> | null) ?? {};
  const antes = currentMetadata.modo_sombra === true;
  const nextMetadata: Record<string, unknown> = { ...currentMetadata, modo_sombra: parsed.data.modo_sombra };

  const { error: updErr } = await admin
    .from("channel_sessions")
    .update({ metadata: nextMetadata })
    .eq("organization_id", auth.org.orgId)
    .eq("id", id);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  void audit({
    action: "ai.modo_sombra_changed",
    actorUserId: auth.user.id,
    organizationId: auth.org.orgId,
    resourceType: "channel_session",
    resourceId: id,
    requestId,
    metadata: { escopo: "canal", antes, depois: parsed.data.modo_sombra },
  });

  return ok({ modo_sombra: parsed.data.modo_sombra }, { requestId });
}
