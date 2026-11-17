/**
 * Berseba: POST /api/v1/voz/call-ended — the Bia's call report lands on the lead (Berseba/berseba
 * issue #232, Voz's `call.ended` webhook).
 *
 * Bearer `dsk_…` with `mcp:write` and at least `agent` (`authorizeVozWrite`); the organization
 * comes from the token row, never from the body. The rule lives in `applyVozReport`
 * (`lib/integrations/voz/report.ts`).
 *
 * Voz retries 401/403/408/409/429 and any 5xx for a day and gives up on any other 4xx, so: every
 * business outcome (applied, already there, no contact, no lead, refused by the lead rule) is a
 * 200 with `data.outcome`; a bad body is a 400 (never retried); a concurrent edit is a 409 and a
 * database that did not answer is a 503, both retried.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { authorizeVozWrite } from "@/lib/integrations/voz/auth";
import { applyVozReport, vozCallEndedSchema } from "@/lib/integrations/voz/report";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await authorizeVozWrite(req.headers.get("authorization"), requestId);
  if (!auth.ok) return auth.response;
  const supportDenied = await requireSupportWrite(auth.organizationId);
  if (supportDenied) return supportDenied;

  const body: unknown = await req.json().catch(() => undefined);
  const parsed = vozCallEndedSchema.safeParse(body);
  if (!parsed.success) {
    return fail("invalid_request", "Invalid call report.", 400, {
      requestId,
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
    });
  }

  try {
    const result = await applyVozReport(
      auth.supabase,
      { organizationId: auth.organizationId, apiTokenId: auth.apiTokenId, requestId },
      parsed.data,
    );
    switch (result.outcome) {
      case "conflict":
        return fail("lead_stage_changed_concurrent", "The card changed at the same time.", 409, {
          requestId,
        });
      case "unavailable":
        return fail("upstream_unavailable", "Database unavailable.", 503, {
          requestId,
          headers: { "Retry-After": "30" },
        });
      default:
        return ok(
          {
            outcome: result.outcome,
            lead_id: result.leadId ?? null,
            ...(result.resultado ? { resultado: result.resultado } : {}),
            ...(result.code ? { code: result.code } : {}),
          },
          { requestId },
        );
    }
  } catch (err) {
    logger.error("voz.call_report_failed", {
      requestId,
      organization_id: auth.organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail("internal_error", "Internal error.", 500, { requestId });
  }
}
