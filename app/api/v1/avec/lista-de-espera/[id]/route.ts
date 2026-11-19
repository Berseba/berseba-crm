/**
 * Berseba: what the team does to one waitlist entry — move it up or down the queue, take it off
 * the list, or search avec for it now.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  dispararBuscaDaEspera,
  procurarAgoraAvec,
  salaoDaOrganizacao,
} from "@/lib/integrations/avec/lista-de-espera-supabase";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const acaoSchema = z.strictObject({ acao: z.enum(["subir", "descer", "remover", "procurar"]) });

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "avec_waitlist" });
  if (!authz.ok) return authz.response;
  const org = authz.org.orgId;
  if (!salaoDaOrganizacao(org)) return fail("not_found", "Not found.", 404, { requestId });
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return fail("not_found", "Inscrição não encontrada.", 404, { requestId });
  const parsed = acaoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Ação inválida.", 422, { requestId });

  const admin = createAdminClient();
  const { data: linha, error } = await admin
    .from("avec_waitlist")
    .select("id, ordem, status")
    .eq("organization_id", org)
    .eq("id", id)
    .in("status", ["waiting", "offered"])
    .maybeSingle();
  if (error) return fail("internal_error", "Não foi possível ler a inscrição.", 500, { requestId });
  if (!linha) return fail("not_found", "Inscrição não encontrada.", 404, { requestId });
  const agora = new Date();
  const { acao } = parsed.data;

  if (acao === "procurar") {
    const r = await procurarAgoraAvec(admin, org, agora, id);
    if (!r) return fail("conflict", "Ligue a lista de espera antes de procurar vagas.", 409, { requestId });
    return ok(r, { requestId });
  }

  if (acao === "remover") {
    const { data: removidas, error: erro } = await admin
      .from("avec_waitlist")
      .update({ status: "cancelled", encerrada_em: agora.toISOString(), updated_at: agora.toISOString() })
      .eq("organization_id", org)
      .eq("id", id)
      .in("status", ["waiting", "offered"])
      .select("id");
    if (erro) return fail("internal_error", "Não foi possível remover.", 500, { requestId });
    // Booked or closed meanwhile (the client said yes): nothing to remove.
    if ((removidas ?? []).length !== 1) {
      return fail("conflict", "Esta inscrição acabou de mudar. Atualize a tela.", 409, { requestId });
    }
    void audit({
      action: "avec.lista_de_espera_removida",
      organizationId: org,
      actorUserId: authz.user.id,
      requestId,
      resourceType: "avec_waitlist",
      resourceId: id,
      metadata: { tinha_oferta: linha.status === "offered" },
    });
    // A slot held for her is free for the next one.
    if (linha.status === "offered") dispararBuscaDaEspera(org);
    return ok({ removida: true }, { requestId });
  }

  // subir / descer: swap the order with the neighbour.
  const vizinho = admin
    .from("avec_waitlist")
    .select("id, ordem")
    .eq("organization_id", org)
    .in("status", ["waiting", "offered"]);
  const { data: vizinhos, error: erroVizinho } =
    acao === "subir"
      ? await vizinho.lt("ordem", linha.ordem).order("ordem", { ascending: false }).limit(1)
      : await vizinho.gt("ordem", linha.ordem).order("ordem", { ascending: true }).limit(1);
  if (erroVizinho) return fail("internal_error", "Não foi possível mudar a ordem.", 500, { requestId });
  const outro = (vizinhos ?? [])[0] as { id: string; ordem: number } | undefined;
  if (!outro) return ok({ movida: false }, { requestId });
  const [a, b] = await Promise.all([
    admin.from("avec_waitlist").update({ ordem: outro.ordem }).eq("organization_id", org).eq("id", id),
    admin.from("avec_waitlist").update({ ordem: linha.ordem }).eq("organization_id", org).eq("id", outro.id),
  ]);
  if (a.error || b.error) return fail("internal_error", "Não foi possível mudar a ordem.", 500, { requestId });
  return ok({ movida: true }, { requestId });
}
