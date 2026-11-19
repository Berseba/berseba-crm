/**
 * Berseba: POST /api/v1/mirae/reminder-messages — a Mirae reminder becomes a message written by
 * the agent: a draft a person approves, or (organization setting `auto`, confirmations and charge
 * notices only) the agent's automatic send through the normal send gate (berseba-crm#127).
 *
 * Same auth, buckets and answers as `/api/v1/mirae/milestones`: Bearer `dsk_…` with `mcp:write`
 * and at least `agent` (`authorizeMiraeWrite`); the organization comes from the token row, never
 * from the body. The rule lives in `queueMiraeReminderMessage`
 * (`lib/integrations/mirae/reminder-message.ts`).
 *
 * Mirae calls from a queue that retries on 409/429/5xx, so every business outcome is a 200 with
 * `data.outcome` (`drafted`, `scheduled`, `already_drafted`, `already_handled`,
 * `contact_not_found`, `contact_blocked`); a malformed body is a 400, and reminder messages turned
 * off for the organization (`reminder_messages_disabled`) or a `kind: "charge"` whose
 * `charge_link` (https on `asaas.com`), `charge_due_date` (`YYYY-MM-DD`) or `charge_amount_cents`
 * (positive integer) is missing or invalid (`invalid_charge`, fields in `details.fields`) a 422,
 * all final.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { isLeadInHandoff } from "@/lib/agent-engine/agent/human-handoff";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { authorizeMiraeWrite } from "@/lib/integrations/mirae/read-auth";
import {
  conversationUrl,
  miraeReminderMessageSchema,
  queueMiraeReminderMessage,
  reminderDbPg,
} from "@/lib/integrations/mirae/reminder-message";
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
  const parsed = miraeReminderMessageSchema.safeParse(body);
  if (!parsed.success) {
    return fail("invalid_request", "Invalid reminder message.", 400, {
      requestId,
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
    });
  }

  let pool;
  try {
    pool = getRequestPool();
  } catch {
    return fail("upstream_unavailable", "Database unavailable.", 503, {
      requestId,
      headers: { "Retry-After": "30" },
    });
  }

  try {
    const result = await queueMiraeReminderMessage(
      reminderDbPg(pool, (orgId, contactId) => isLeadInHandoff(pool, orgId, contactId)),
      { organizationId: auth.organizationId, now: new Date() },
      parsed.data,
    );
    const log = {
      organization_id: auth.organizationId,
      request_id: requestId,
      reminder_id: parsed.data.reminder_id,
      kind: parsed.data.kind ?? null,
      outcome: result.outcome,
      delivery: result.delivery ?? null,
      cron_job_id: result.cronJobId ?? null,
      replayed: result.replayed ?? false,
    };

    if (result.outcome === "invalid_charge") {
      logger.warn("mirae.reminder_message_invalid_charge", { ...log, fields: result.invalidFields ?? [] });
      return fail("invalid_charge", "The charge link, due date or amount is missing or invalid.", 422, {
        requestId,
        details: { fields: result.invalidFields ?? [] },
      });
    }

    if (result.outcome === "disabled") {
      logger.warn("mirae.reminder_message_disabled", log);
      return fail(
        "reminder_messages_disabled",
        "Reminder messages are turned off for this organization.",
        422,
        { requestId },
      );
    }

    const created =
      (result.outcome === "drafted" || result.outcome === "scheduled") && !result.replayed;
    if (created) {
      logger.info("mirae.reminder_message_queued", log);
      await audit({
        action: "mirae.reminder_message_queued",
        actorUserId: null,
        actorApiTokenId: auth.apiTokenId,
        organizationId: auth.organizationId,
        resourceType: "conversation",
        resourceId: result.conversationId ?? null,
        requestId,
        metadata: {
          actor_type: "api_token",
          actor_api_token_id: auth.apiTokenId,
          reminder_id: parsed.data.reminder_id,
          delivery: result.delivery,
          cron_job_id: result.cronJobId,
        },
      });
    } else {
      logger.info("mirae.reminder_message_not_queued", log);
    }

    return ok(
      {
        outcome: result.outcome,
        ...(result.conversationId
          ? { conversation_url: conversationUrl(env.NEXT_PUBLIC_APP_URL, result.conversationId) }
          : {}),
        ...(result.replayed ? { replayed: true } : {}),
      },
      { requestId },
    );
  } catch (err) {
    logger.error("mirae.reminder_message_failed", {
      requestId,
      organization_id: auth.organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail("internal_error", "Internal error.", 500, { requestId });
  }
}
