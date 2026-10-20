import { describe, expect, it } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

/**
 * Berseba: an opted-out contact (`contacts.is_blocked`) stops every automatic
 * sender, never a person replying from the CRM.
 *
 * The block is written on ingestion by a keyword match, and a false positive
 * ("Cancelar" tapped on a booking reminder) used to leave the attendant unable
 * to answer a client who was still talking. Sabotage: drop the
 * `ctx.actor.type !== "user"` from the gate in `app/api/v1/messages/_handler.ts`
 * and the attendant case fails; drop the gate and the automatic cases fail.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";

function blockedConversation() {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    bot_silenced_until: null,
    provider_conversation_id: null,
    last_inbound_at: new Date().toISOString(),
    contacts: {
      phone_number: "+5511999999999",
      wa_identity: null,
      wa_lid: null,
      is_blocked: true,
      is_personal: false,
    },
    channel_sessions: { provider: "zernio", status: "WORKING", archived_at: null },
  };
}

const text = (): SendMessageInput =>
  ({ conversation_id: CONV, type: "text", body: "oi" }) as SendMessageInput;

async function sendError(actor: HandlerCtx["actor"]): Promise<unknown> {
  const { supabase } = criarDubleDoHandler({ conversation: blockedConversation() });
  const ctx: HandlerCtx = { organization_id: ORG, actor, requestId: "req-blocked" };
  return sendMessageHandler(supabase, ctx, text()).then(
    () => null,
    (e: unknown) => e,
  );
}

function isBlockedRefusal(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403 && /bloqueou/i.test(err.message);
}

describe("opted-out contact", () => {
  it("the AI agent is refused", async () => {
    expect(isBlockedRefusal(await sendError({ type: "ai_agent", id: "ag-1", role: "agent" }))).toBe(true);
  });

  it("a server token integration is refused", async () => {
    expect(isBlockedRefusal(await sendError({ type: "api_token", id: "tok-1" }))).toBe(true);
  });

  it("an automation rule is refused", async () => {
    const err = await sendError({ type: "webhook_source", id: "rule-1" });
    expect(isBlockedRefusal(err)).toBe(true);
  });

  it("the attendant replying from the CRM is not refused by the block", async () => {
    // Does not prove end-to-end delivery (that is the channel's job): proves
    // the block no longer stops a person. Any error left is not the block's.
    expect(isBlockedRefusal(await sendError({ type: "user", id: USER }))).toBe(false);
  });
});
