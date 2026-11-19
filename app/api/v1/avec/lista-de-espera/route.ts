/**
 * Berseba: the avec salon's waitlist for the team — the queue, the organization's settings and
 * a new entry. Only for organizations that use avec and have a salon catalog; any other answers
 * 404. Reads go through the session (RLS); writes use the service client after the role check,
 * with the organization from the validated session, never from the body.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { configDaListaDeEsperaSchema } from "@/lib/agenda/lista-de-espera";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { conferirPedido } from "@/lib/integrations/avec/busca";
import { dataSchema, horaSchema, hojeNoSalao, MAX_DIAS_A_FRENTE, somarDias } from "@/lib/integrations/avec/lista-de-espera";
import { dispararBuscaDaEspera, salaoDaOrganizacao } from "@/lib/integrations/avec/lista-de-espera-supabase";
import { COMPRIMENTOS } from "@/lib/integrations/avec/ofertas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const RECURSO = "avec_waitlist";

const COLUNAS =
  "id, contact_id, pedido, data_de, data_ate, depois_de, ate, substitui_data, ordem, status, oferta, oferta_expira_em, observacoes, created_by_kind, created_at, encerrada_em, resultado";

const inscreverSchema = z.strictObject({
  contact_id: z.uuid(),
  servico: z.string().trim().min(1).max(40),
  comprimento: z.enum(COMPRIMENTOS).nullish(),
  profissional: z.string().trim().min(1).max(60).nullish(),
  data_de: dataSchema,
  data_ate: dataSchema,
  depois_de: horaSchema.nullish(),
  ate: horaSchema.nullish(),
  substitui_data: dataSchema.nullish(),
  observacoes: z.string().trim().max(500).nullish(),
});

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;
  const org = authz.org.orgId;
  const salao = salaoDaOrganizacao(org);
  if (!salao) return fail("not_found", "Not found.", 404, { requestId });

  const supabase = await createClient();
  const [{ data: organizacao, error: erroOrg }, { data: vivas, error: erroVivas }, { data: encerradas, error: erroEnc }] =
    await Promise.all([
      supabase.from("organizations").select("settings").eq("id", org).single(),
      supabase
        .from("avec_waitlist")
        .select(COLUNAS)
        .eq("organization_id", org)
        .in("status", ["waiting", "offered"])
        .order("ordem", { ascending: true })
        .limit(200),
      supabase
        .from("avec_waitlist")
        .select(COLUNAS)
        .eq("organization_id", org)
        .in("status", ["booked", "cancelled", "expired"])
        .order("encerrada_em", { ascending: false, nullsFirst: false })
        .limit(30),
    ]);
  if (erroOrg || erroVivas || erroEnc) {
    return fail("internal_error", "Não foi possível carregar a lista de espera.", 500, { requestId });
  }
  const linhas = [...(vivas ?? []), ...(encerradas ?? [])] as Array<{ contact_id: string }>;
  const ids = [...new Set(linhas.map((l) => l.contact_id))];
  const { data: contatos } = ids.length
    ? await supabase
        .from("contacts")
        .select("id, name, display_name, phone_number")
        .eq("organization_id", org)
        .in("id", ids)
    : { data: [] };
  const nomes = new Map(
    ((contatos ?? []) as Array<{ id: string; name: string | null; display_name: string | null; phone_number: string | null }>).map(
      (c) => [c.id, c.name?.trim() || c.display_name?.trim() || c.phone_number || null],
    ),
  );
  const comNome = (l: Record<string, unknown>) => ({ ...l, contato: nomes.get(String(l.contact_id)) ?? null });

  const settings = organizacao?.settings as Record<string, unknown> | null;
  const config = configDaListaDeEsperaSchema.safeParse(settings?.lista_de_espera);
  return ok(
    {
      config: config.success ? config.data : null,
      fila: (vivas ?? []).map(comNome),
      encerradas: (encerradas ?? []).map(comNome),
      servicos: salao.ofertas.map((o) => ({
        id: o.id,
        nome: o.rotulo,
        precisa_comprimento: o.comprimento,
        profissionais: o.porProfissional.map((p) => ({
          id: p.profissional,
          nome: salao.profissionais[p.profissional]?.nome ?? p.profissional,
        })),
      })),
      profissionais: Object.fromEntries(Object.values(salao.profissionais).map((p) => [p.id, p.nome])),
    },
    { requestId },
  );
}

/** The organization's switch and deadlines. Same keys as upstream's waitlist module. */
export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;
  const org = authz.org.orgId;
  if (!salaoDaOrganizacao(org)) return fail("not_found", "Not found.", 404, { requestId });

  const parsed = configDaListaDeEsperaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Preencha os três prazos antes de ligar a lista de espera.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const admin = createAdminClient();
  const { data, error: erroLeitura } = await admin.from("organizations").select("settings").eq("id", org).single();
  if (erroLeitura) return fail("internal_error", "Não foi possível salvar.", 500, { requestId });
  const { error } = await admin
    .from("organizations")
    .update({ settings: { ...(data.settings as Record<string, unknown>), lista_de_espera: parsed.data } })
    .eq("id", org);
  if (error) return fail("internal_error", "Não foi possível salvar.", 500, { requestId });

  void audit({
    action: "avec.lista_de_espera_configurada",
    organizationId: org,
    actorUserId: authz.user.id,
    requestId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    metadata: parsed.data,
  });
  if (parsed.data.ativa) dispararBuscaDaEspera(org);
  return ok(parsed.data, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;
  const org = authz.org.orgId;
  const salao = salaoDaOrganizacao(org);
  if (!salao) return fail("not_found", "Not found.", 404, { requestId });

  const parsed = inscreverSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Confira os dados da inscrição.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const p = parsed.data;
  const hoje = hojeNoSalao(new Date());
  if (p.data_de < hoje || p.data_ate < p.data_de || p.data_ate > somarDias(hoje, MAX_DIAS_A_FRENTE)) {
    return fail("validation_failed", "Os dias precisam ser de hoje em diante, e o último depois do primeiro.", 422, {
      requestId,
    });
  }
  if (p.depois_de && p.ate && p.ate < p.depois_de) {
    return fail("validation_failed", "A faixa de horário está invertida.", 422, { requestId });
  }
  const conferido = conferirPedido(salao, {
    servico: p.servico,
    comprimento: p.comprimento ?? null,
    profissional: p.profissional ?? null,
  });
  if (!conferido.ok) {
    const mensagens: Record<string, string> = {
      servico_desconhecido: "Serviço desconhecido.",
      precisa_comprimento: "Este serviço precisa do comprimento do cabelo.",
      profissional_nao_faz: "Essa profissional não faz este serviço.",
      comprimento_com_a_equipe: "Esse comprimento não é marcado pelo sistema.",
    };
    return fail("validation_failed", mensagens[conferido.motivo] ?? "Pedido inválido.", 422, { requestId });
  }

  const admin = createAdminClient();
  const { data: contato } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", org)
    .eq("id", p.contact_id)
    .eq("is_anonymized", false)
    .maybeSingle();
  if (!contato) return fail("not_found", "Contato não encontrado.", 404, { requestId });

  const { data, error } = await admin
    .from("avec_waitlist")
    .insert({
      organization_id: org,
      contact_id: p.contact_id,
      pedido: {
        servico: p.servico,
        comprimento: conferido.comprimento,
        profissional: p.profissional && conferido.principais.length === 1 ? conferido.principais[0] : null,
      },
      data_de: p.data_de,
      data_ate: p.data_ate,
      depois_de: p.depois_de ?? null,
      ate: p.ate ?? null,
      substitui_data: p.substitui_data ?? null,
      observacoes: p.observacoes ?? null,
      created_by_kind: "user",
      created_by_user_id: authz.user.id,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") {
      return fail("conflict", "Essa cliente já está na lista para este serviço.", 409, { requestId });
    }
    return fail("internal_error", "Não foi possível adicionar.", 500, { requestId });
  }
  void audit({
    action: "avec.lista_de_espera_inscrita",
    organizationId: org,
    actorUserId: authz.user.id,
    requestId,
    resourceType: "avec_waitlist",
    resourceId: data.id as string,
    metadata: { servico: p.servico },
  });
  dispararBuscaDaEspera(org);
  return ok({ id: data.id }, { requestId, status: 201 });
}
