/**
 * Berseba: a manager or admin may edit or delete-for-everyone an outbound the
 * AI agent sent (`messages.sent_via = 'ai'`).
 *
 * Upstream only lets a person alter their OWN message sent from the CRM. When a
 * clinic turns the agent on, the team watches it closely and needs to fix a
 * wrong reply after it went out (Instituto Jordão go-live, 2026-11). The AI has
 * no `sent_by_user_id`, so nobody could touch its messages.
 *
 * Only the WHO changes. Every other condition of upstream's rule (outbound,
 * channel id present, not revoked, sent/delivered/read, text only for edit,
 * 15-minute edit window, channel supports it) still applies. `automation`
 * and `system` messages stay out on purpose.
 *
 * The route (`app/api/v1/messages/[id]/route.ts`), the thread
 * (`components/inbox/ChatThread.tsx`) and the bubble
 * (`components/inbox/MessageBubble.tsx`) all ask this function, so the button
 * never offers what the route refuses.
 */
import { roleAtLeast } from "@/lib/auth/types";

/** True when `role` (the caller's effective role) may alter a message sent via `sentVia`. */
export function managerMayAlterAiMessage(
  sentVia: string | null | undefined,
  role: string | null | undefined,
): boolean {
  return sentVia === "ai" && roleAtLeast(role, "manager");
}
