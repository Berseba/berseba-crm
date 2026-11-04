/**
 * Berseba: POST /api/v1/mirae/milestones — a milestone in Mirae (evaluation booked, attended,
 * missed, enrolled) moves the person's card (Mirae ADR-073, "ponte ②").
 *
 * Bearer `dsk_…` with `mcp:write` and at least `agent` (`authorizeMiraeWrite`); the organization
 * comes from the token row, never from the body. The rule lives in `applyMiraeMilestone`
 * (`lib/integrations/mirae/milestone.ts`).
 *
 * Mirae calls from a queue that retries on any non-2xx, so the status says whether a retry helps:
 * every business outcome (moved, already there, no contact, refused by the lead rule…) is a 200
 * with `data.outcome`; a wrong map is a 422; a concurrent edit is a 409 and a database that did
 * not answer is a 503, both worth retrying.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { authorizeMiraeWrite } from "@/lib/integrations/mirae/read-auth";
import { applyMiraeMilestone, miraeMilestoneSchema } from "@/lib/integrations/mirae/milestone";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await authorizeMiraeWrite(req.headers.get("authorization"), requestId);
  if (!auth.ok) return auth.response;
  const supportDenied = await requireSupportWrite(auth.organizationId);
  if (supportDenied) return supportDenied;

  const body: unknown = await req.json().catch(() => undefined);
  const parsed = miraeMilestoneSchema.safeParse(body);
  if (!parsed.success) {
    return fail("invalid_request", "Invalid milestone.", 400, {
      requestId,
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
    });
  }

  try {
    const result = await applyMiraeMilestone(
      auth.supabase,
      { organizationId: auth.organizationId, apiTokenId: auth.apiTokenId, requestId },
      parsed.data,
    );
    switch (result.outcome) {
      case "invalid_stage":
        return fail("invalid_stage", "The stage does not fit this funnel or milestone.", 422, {
          requestId,
          details: { reason: result.code },
        });
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
            ...(result.code ? { code: result.code } : {}),
            ...(result.detail ? { detail: result.detail } : {}),
          },
          { requestId },
        );
    }
  } catch (err) {
    logger.error("mirae.milestone_failed", {
      requestId,
      organization_id: auth.organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail("internal_error", "Internal error.", 500, { requestId });
  }
}
