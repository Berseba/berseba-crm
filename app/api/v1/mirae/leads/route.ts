/**
 * Berseba: GET /api/v1/mirae/leads — the studio's entry funnel, read by Mirae (Mirae ADR-073).
 *
 * Bearer `dsk_…` only, scope `mcp:read`, rank `viewer`; the organization comes from the token row
 * (`lib/integrations/mirae/read-auth.ts`). The reading itself is `listMiraeLeads`
 * (`lib/integrations/mirae/funnel-read.ts`). Needs its `PUBLIC_PATHS` entry, or the proxy answers
 * 401 to every Bearer before this file runs.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { leadsQuerySchema, listMiraeLeads } from "@/lib/integrations/mirae/funnel-read";
import { authorizeMiraeRead } from "@/lib/integrations/mirae/read-auth";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await authorizeMiraeRead(req.headers.get("authorization"), requestId);
  if (!auth.ok) return auth.response;

  const params = new URL(req.url).searchParams;
  const parsed = leadsQuerySchema.safeParse({
    pipeline_id: params.get("pipeline_id") ?? undefined,
    created_from: params.get("created_from") ?? undefined,
    created_to: params.get("created_to") ?? undefined,
    cursor: params.get("cursor") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", "Invalid query.", 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  try {
    const result = await listMiraeLeads(auth.supabase, auth.organizationId, parsed.data);
    if (!result.ok) return fail("not_found", "Pipeline not found.", 404, { requestId });
    const res = NextResponse.json({ data: result.data, next_cursor: result.next_cursor });
    res.headers.set("X-Request-Id", requestId);
    return res;
  } catch (err) {
    logger.error("mirae.leads_read_failed", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail("internal_error", "Internal error.", 500, { requestId });
  }
}
