/**
 * Invite signup without a second email (Berseba).
 *
 * ─── The incident ───────────────────────────────────────────────────────────
 *
 * 2026-10-09, crm.grupoberseba.com.br: two people opened their team invite
 * links and created an account with email and password. Supabase Auth logged
 * `user_confirmation_requested`, the confirmation email never reached their
 * Hotmail inboxes, and every login after that failed with
 * `400 email_not_confirmed`. They were let in by hand: `email_confirmed_at`
 * set in the database, then `fn_accept_team_invite` called.
 *
 * The confirmation email asked them to prove something the invite already
 * proved. The invite link was sent to that address, its token is HMAC-signed,
 * and `decidirConviteDoSignup` checks that the email in the token is the email
 * being registered. A second email only added a delivery dependency
 * (the Supabase Auth SMTP) on the first-impression path.
 *
 * ─── What this module does ──────────────────────────────────────────────────
 *
 * Given a valid invite token for this exact email, it creates the account
 * already confirmed through the admin API (`email_confirm: true`) and applies
 * the invite (`aplicarConvite`) in the same request. Open self-signup without
 * an invite does not come here and keeps email confirmation.
 *
 * ─── The trade-off, stated ──────────────────────────────────────────────────
 *
 * Upstream's `criarContaDeConvite` (`lib/auth/convite-no-gotrue.ts`) chose
 * `email_confirm: false` on purpose: an invite link can be forwarded, and the
 * admin can also copy it and send it over WhatsApp (`issueInvite` always
 * returns the link). Whoever holds the link within its 24 h can now create the
 * account for that email without owning the mailbox. That is the same power the
 * link already gives to anyone who is logged in as that email; what changes is
 * that it no longer needs the mailbox. Limits that still hold:
 *
 * - the email is fixed by the signed token, not by the form;
 * - only ONE account per email: once the invitee has a confirmed account, the
 *   token cannot create or take over another one (`account_exists`);
 * - a revoked invite (Team screen) is refused before any account is created,
 *   and an accepted one never creates a new account;
 * - the mailbox owner can always take the account back with "Esqueci minha
 *   senha", because password recovery still goes to the mailbox.
 *
 * ─── An existing, never-confirmed account ───────────────────────────────────
 *
 * The people in the incident already had an account: created, never
 * confirmed. Opening the invite again ended in "conta já existe", and the login
 * then failed with `email_not_confirmed`. An unconfirmed account carries no
 * proof of ownership (nobody ever clicked its link), so the invite, which does
 * carry proof for this email, confirms it and sets the password just typed.
 * A CONFIRMED account is never touched: that person logs in and accepts the
 * invite from the Team screen link, as before. Neither is an unconfirmed
 * account that already holds a membership or a platform role
 * (`holdsOtherAuthority`).
 */
import { decidirConviteDoSignup } from "@/lib/auth/convite-no-signup";
import { aplicarConvite } from "@/lib/auth/aplicar-convite";
import type { InvitePayload } from "@/lib/auth/invite-token";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

export type InviteSignupResult =
  | { ok: true; userId: string; created: boolean }
  | {
      ok: false;
      /**
       * `invalid_invite`: token not signed by us, expired, issued for
       * another email, or already spent. `invite_revoked`: cancelled on the
       * Team screen. `account_exists`: the email belongs to an account the
       * invite may not take over (confirmed, or already holding authority).
       * The other three are infrastructure failures.
       */
      reason:
        | "invalid_invite"
        | "invite_revoked"
        | "account_exists"
        | "rate_limited"
        | "create_failed"
        | "accept_failed";
      detail?: string;
    };

/** Accounts per page when scanning the directory; the server may return fewer. */
const USERS_PER_PAGE = 200;
/** Page ceiling. Not found within it means `account_exists`, never a takeover. */
const MAX_PAGES = 50;

type Admin = ReturnType<typeof createAdminClient>;

interface ExistingUser {
  id: string;
  confirmed: boolean;
  userMetadata: Record<string, unknown>;
}

/**
 * `listUsers` does not filter by email (same constraint `lib/auth/provision.ts`
 * documents), so this walks the pages. It only runs when GoTrue already said
 * the email exists, never on the happy path. It stops on an empty page instead
 * of trusting `nextPage` (see the note in `provision.ts`).
 */
async function findUserByEmail(admin: Admin, email: string): Promise<ExistingUser | null> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: USERS_PER_PAGE });
    if (error) throw new Error(`invite signup: user lookup failed: ${error.message}`);
    if (data.users.length === 0) return null;
    const found = data.users.find((u) => u.email?.trim().toLowerCase() === email);
    if (found) {
      return {
        id: found.id,
        confirmed: Boolean(found.email_confirmed_at),
        userMetadata: (found.user_metadata ?? {}) as Record<string, unknown>,
      };
    }
  }
  return null;
}

function isEmailExists(error: { code?: string; message: string } | null): boolean {
  if (!error) return false;
  // `email_exists` is the current GoTrue code; older versions only said
  // "already been registered" in the message (same rule as `provision.ts`).
  return error.code === "email_exists" || /already (been )?registered|already exists/i.test(error.message);
}

type ApplyResult = { ok: true } | { ok: false; reason: "invite_revoked" | "accept_failed"; detail?: string };

/**
 * `aplicarConvite` reports its failures as values, but it also reaches the
 * admin client, `cookies()` and the audit; a throw from any of them must take
 * the same rollback path as a refusal, not leave a confirmed account behind.
 */
async function applyInvite(
  userId: string,
  payload: InvitePayload,
  requestId: string | null,
): Promise<ApplyResult> {
  try {
    const accepted = await aplicarConvite({ userId, payload, requestId });
    if (accepted.ok) return { ok: true };
    return { ok: false, reason: accepted.motivo === "invalid_or_expired" ? "invite_revoked" : "accept_failed" };
  } catch (e) {
    return { ok: false, reason: "accept_failed", detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Does this never-confirmed account already carry authority the invite did
 * not grant? Then the invite must not hand it over: whoever holds the link
 * would inherit a membership or a platform role by setting the password. It
 * happens when someone links an account by hand before it is confirmed (the
 * 2026-10-09 fix was done in the safe order; the reverse is one SQL away).
 *
 * The one membership that is allowed is the one THIS invite already created:
 * a previous attempt of this flow applied the invite and then failed to
 * confirm the account (`accepted_by` on the invite row says so).
 *
 * A failed read throws: "could not check" must not become "nothing there".
 */
async function holdsOtherAuthority(
  admin: Admin,
  userId: string,
  payload: InvitePayload,
  inviteAcceptedBy: string | null,
): Promise<boolean> {
  const { data: platformRole, error: platformError } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();
  if (platformError) throw new Error(`invite signup: platform role lookup failed: ${platformError.message}`);
  if (platformRole) return true;

  // Cross-tenant on purpose and by user id only: the question is whether this
  // account belongs anywhere, not what any organization contains.
  const { data: memberships, error: membershipError } = await admin
    .from("user_organizations")
    .select("organization_id")
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (membershipError) throw new Error(`invite signup: membership lookup failed: ${membershipError.message}`);

  return (memberships ?? []).some(
    (m) => m.organization_id !== payload.organization_id || inviteAcceptedBy !== userId,
  );
}

export async function completeInviteSignup(params: {
  email: string;
  password: string;
  fullName: string;
  inviteToken: string;
  requestId?: string | null;
}): Promise<InviteSignupResult> {
  const email = params.email.trim().toLowerCase();
  const requestId = params.requestId ?? null;

  // The same decision `/auth/confirm` makes, with the same pure function: the
  // signature AND the email match. The email here is the one being registered;
  // it is not yet "confirmed by the provider", and that is the point of this
  // module: the signed invite is the proof of the address.
  const decision = decidirConviteDoSignup({ email }, params.inviteToken);
  if (decision.tipo !== "convite") return { ok: false, reason: "invalid_invite" };
  const { payload } = decision;

  const admin = createAdminClient();

  // The invite row, read BEFORE creating anything (`aplicarConvite` reads it
  // again, but by then a confirmed account would already exist):
  // - revoked on the Team screen → refused;
  // - already accepted → the link is spent. It may still finish its own
  //   half-done attempt (below), but it never creates a new account: if the
  //   account that accepted it was deleted, a forwarded link must not bring
  //   it back without the mailbox.
  // A failed read fails closed. Invites issued before migration 0238 have no
  // row and go through, as in `aplicarConvite`.
  const { data: inviteRow, error: inviteRowError } = await admin
    .from("team_invites")
    .select("revoked_at, accepted_at, accepted_by")
    .eq("id", payload.invite_id)
    .eq("organization_id", payload.organization_id)
    .maybeSingle();
  if (inviteRowError) return { ok: false, reason: "create_failed", detail: inviteRowError.message };
  if (inviteRow?.revoked_at) return { ok: false, reason: "invite_revoked" };
  const spent = Boolean(inviteRow?.accepted_at);
  const acceptedBy = (inviteRow?.accepted_by as string | null | undefined) ?? null;

  if (!spent) {
    // `invite_token` is NOT stored in `user_metadata`: the invite is applied
    // right here, and a token left in the metadata would be read again by the
    // `/auth/callback` and `/auth/confirm` decisions long after it expired.
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password: params.password,
      email_confirm: true,
      user_metadata: { full_name: params.fullName },
    });

    if (created?.user) {
      const applied = await applyInvite(created.user.id, payload, requestId);
      if (applied.ok) return { ok: true, userId: created.user.id, created: true };

      // Undo the account: a confirmed account with no organization is the
      // "logged in, empty CRM" state this whole flow exists to avoid, and
      // keeping it would turn every retry into `account_exists`.
      const { error: deleteError } = await admin.auth.admin.deleteUser(created.user.id);
      if (deleteError) {
        logger.error("invite signup: could not undo the account after the invite failed", {
          user_id: created.user.id,
          detail: deleteError.message,
        });
      }
      return { ok: false, reason: applied.reason, ...(applied.detail ? { detail: applied.detail } : {}) };
    }

    if (createError?.status === 429) return { ok: false, reason: "rate_limited" };
    if (!isEmailExists(createError)) {
      return { ok: false, reason: "create_failed", detail: createError?.message ?? "no user returned" };
    }
  }

  // The email already has an account (or the invite is spent).
  let existing: ExistingUser | null;
  try {
    existing = await findUserByEmail(admin, email);
  } catch (e) {
    return { ok: false, reason: "create_failed", detail: e instanceof Error ? e.message : String(e) };
  }
  if (!existing) return { ok: false, reason: spent ? "invalid_invite" : "account_exists" };
  if (existing.confirmed) return { ok: false, reason: "account_exists" };
  // A spent invite only finishes the attempt of the account that accepted it.
  if (spent && acceptedBy !== existing.id) return { ok: false, reason: "invalid_invite" };

  try {
    if (await holdsOtherAuthority(admin, existing.id, payload, acceptedBy)) {
      return { ok: false, reason: "account_exists" };
    }
  } catch (e) {
    return { ok: false, reason: "create_failed", detail: e instanceof Error ? e.message : String(e) };
  }

  // Never confirmed and carrying nothing else: the invite completes it.
  // Membership first, so a failure here changes nothing about the account.
  const applied = await applyInvite(existing.id, payload, requestId);
  if (!applied.ok) {
    return { ok: false, reason: applied.reason, ...(applied.detail ? { detail: applied.detail } : {}) };
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(existing.id, {
    password: params.password,
    email_confirm: true,
    // The old flow left `invite_token` in the metadata; `null` clears it (GoTrue
    // drops null keys on merge), for the reason given at `createUser` above.
    user_metadata: { ...existing.userMetadata, invite_token: null, full_name: params.fullName },
  });
  if (updateError) {
    // The membership is in place and the invite is marked as accepted by this
    // account; a retry of the same signup lands here again and finishes the
    // confirmation (`spent` with `accepted_by` = this account).
    return { ok: false, reason: "create_failed", detail: updateError.message };
  }
  return { ok: true, userId: existing.id, created: false };
}
