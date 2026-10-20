/**
 * Captura o identificador Google repassado pelo botão da landing page.
 * O site deve preservar gclid, gbraid ou wbraid recebidos na visita.
 * Macros não resolvidas são recusadas; sem identificador válido, o visitante
 * ainda abre o WhatsApp configurado, sem referência inventada.
 * A rota é pública, limitada por IP e organização e nunca envia conversões.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { lerIdentificadoresGoogle } from "@/lib/plataformas-de-anuncio/google/identificadores";

import { criarClickRef } from "@/lib/plataformas-de-anuncio/google/captura-de-clique";
import {
  CAPTURE_WINDOW_SECONDS,
  checkCaptureRateLimit,
} from "@/lib/plataformas-de-anuncio/capture-rate-limit";
import { lerConfigDaLanding } from "@/lib/plataformas-de-anuncio/landing-config";
import {
  clientIp,
  paginaDeSaida,
  textoSemRef,
  whatsAppUrl,
} from "@/lib/plataformas-de-anuncio/pagina-de-captura";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ org: string }>;
}

export async function GET(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const params = z
    .object({
      org: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[a-zA-Z0-9_-]+$/),
    })
    .safeParse(await ctx.params);
  if (!params.success) return paginaDeSaida(null);
  const { org } = params.data;

  // Berseba (#67): IP-wide bucket first, then per (org, IP). See
  // `lib/plataformas-de-anuncio/capture-rate-limit.ts`.
  const limite = await checkCaptureRateLimit("google", org, clientIp(req));
  if (limite === "blocked") {
    return new NextResponse(null, {
      status: 429,
      headers: { "Retry-After": String(CAPTURE_WINDOW_SECONDS) },
    });
  }

  const search = new URL(req.url).searchParams;
  const ids = lerIdentificadoresGoogle(
    Object.fromEntries(
      ["gclid", "gbraid", "wbraid"].flatMap((key) =>
        search.get(key) ? [[key, search.get(key)!]] : [],
      ),
    ),
  );

  const admin = createAdminClient();

  const { data: organizacao, error: erroOrg } = await admin
    .from("organizations")
    .select("id")
    .eq("slug", org)
    .maybeSingle();

  if (erroOrg) {
    logger.error("[anuncios.google.landing] leitura da organização falhou", {
      org,
      detalhe: erroOrg.message,
    });
  }
  const organizationId = (organizacao as { id: string } | null)?.id ?? null;
  if (!organizationId) return paginaDeSaida(null);

  const config = await lerConfigDaLanding(admin, "google_ads_landing_pages", organizationId);
  if (!config) return paginaDeSaida(null);

  // Berseba (#67): over the per-(org, IP) bucket the visitor still reaches
  // WhatsApp, only without the ref and without a write.
  if (limite === "no_ref") {
    return paginaDeSaida(whatsAppUrl(config.whatsappE164, textoSemRef(config.messageTemplate)));
  }

  // Sem identificador válido, mantém o acesso ao WhatsApp sem atribuição.
  if (!ids) {
    logger.warn("[anuncios.google.landing] hit sem identificador Google válido", { org });
    return paginaDeSaida(whatsAppUrl(config.whatsappE164, textoSemRef(config.messageTemplate)));
  }

  const queryRaw = Object.fromEntries(
    ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].flatMap((key) =>
      search.get(key) ? [[key, search.get(key)!.slice(0, 256)]] : [],
    ),
  );
  const criado = await criarClickRef(admin, organizationId, ids, queryRaw);
  if (!criado) {
    // Falha ao gravar o clique: mesma régua — a pessoa não paga o preço de um
    // erro nosso, só a atribuição é que se perde.
    return paginaDeSaida(whatsAppUrl(config.whatsappE164, textoSemRef(config.messageTemplate)));
  }

  const mensagem = config.messageTemplate.replaceAll("{token}", criado.token);
  return paginaDeSaida(whatsAppUrl(config.whatsappE164, mensagem));
}
