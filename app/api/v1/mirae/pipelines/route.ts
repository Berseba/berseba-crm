/**
 * Berseba: GET /api/v1/mirae/pipelines — the organization's live funnels and stages, for Mirae's
 * "milestone → stage" settings screen (Mirae ADR-073).
 *
 * Same auth as `/api/v1/mirae/leads` (`lib/integrations/mirae/read-auth.ts`); reading in
 * `listMiraePipelines` (`lib/integrations/mirae/funnel-read.ts`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { listMiraePipelines } from "@/lib/integrations/mirae/funnel-read";
import { authorizeMiraeRead } from "@/lib/integrations/mirae/read-auth";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await authorizeMiraeRead(req.headers.get("authorization"), requestId);
  if (!auth.ok) return auth.response;

  try {
    const data = await listMiraePipelines(auth.supabase, auth.organizationId);
    const res = NextResponse.json({ data });
    res.headers.set("X-Request-Id", requestId);
    return res;
  } catch (err) {
    logger.error("mirae.pipelines_read_failed", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail("internal_error", "Internal error.", 500, { requestId });
  }
}
