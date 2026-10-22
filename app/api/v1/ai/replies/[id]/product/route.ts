import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { BUCKET_DAS_FOTOS, fotoPertenceAoProduto } from "@/lib/catalogo/fotos";
export const dynamic = "force-dynamic";

/** One hour, like the catalog screen. The panel caches the answer for less than that. */
const THUMBNAIL_TTL_SECONDS = 3600;

/**
 * The product an Assisted-mode draft carries (Berseba, migration 9004): its name
 * and a signed URL of the cover, for the thumbnail in the review panel.
 *
 * Both reads go through the user's session, so RLS decides: the draft only if the
 * user can see its conversation, the product only from the user's organization.
 * Only the signing uses the service role, and it signs a path that belongs to that
 * product (`fotoPertenceAoProduto`) — the `fotos` column is writable through
 * PostgREST, so a path from another organization is never signed.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID(),
    auth = await requireRole("agent", { requestId, resource: "conversations" });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success)
    return fail("validation_failed", "Campos inválidos.", 422, { requestId });
  const db = await createClient();
  const { data: draft } = await db
    .from("ai_reply_drafts")
    .select("product_code")
    .eq("organization_id", auth.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!draft) return fail("not_found", "Sugestão não encontrada.", 404, { requestId });
  if (!draft.product_code) return ok({ product: null }, { requestId });
  // `catalog_products` is not in the generated types (the catalog screen casts too).
  const { data: product } = (await db
    .from("catalog_products")
    .select("id,nome,fotos")
    .eq("organization_id", auth.org.orgId)
    .eq("codigo", draft.product_code)
    .eq("ativo", true)
    .maybeSingle()) as { data: { id: string; nome: string; fotos: string[] | null } | null };
  // Gone since the draft was made: the send will refuse it too (`product_not_found`).
  if (!product)
    return ok({ product: { code: draft.product_code, name: null, thumbnail_url: null } }, { requestId });
  const cover = (product.fotos ?? []).find((path) =>
    fotoPertenceAoProduto(path, auth.org.orgId, product.id),
  );
  let thumbnailUrl: string | null = null;
  if (cover) {
    const { data: signed } = await createAdminClient()
      .storage.from(BUCKET_DAS_FOTOS)
      .createSignedUrl(cover, THUMBNAIL_TTL_SECONDS);
    thumbnailUrl = signed?.signedUrl ?? null;
  }
  return ok(
    { product: { code: draft.product_code, name: product.nome, thumbnail_url: thumbnailUrl } },
    { requestId },
  );
}
