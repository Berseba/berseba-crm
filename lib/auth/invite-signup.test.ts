/**
 * Invite signup confirms the account through the invite (Berseba).
 *
 * The property that matters is a security one: an account is created already
 * confirmed ONLY for the exact email a token we signed was issued to. The
 * spoofing cases below are the ones `lib/auth/convite-no-signup.ts` describes
 * (a token pasted into someone else's signup, a forged or expired token), now
 * aimed at the path that skips the confirmation email. Each one asserts that no
 * account is created and no membership is written, not just the return value.
 */
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { signInviteToken } from "@/lib/auth/invite-token";

const admin = vi.hoisted(() => ({
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  listUsers: vi.fn(),
  updateUserById: vi.fn(),
  /** What each table answers. `team_invites`/`platform_admins` via maybeSingle, `user_organizations` as a list. */
  tables: {} as Record<string, { data: unknown; error: { message: string } | null }>,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      const answer = () => admin.tables[table] ?? { data: null, error: null };
      const chain = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => answer(),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(answer()).then(resolve, reject),
      };
      return chain;
    }),
    auth: {
      admin: {
        createUser: admin.createUser,
        deleteUser: admin.deleteUser,
        listUsers: admin.listUsers,
        updateUserById: admin.updateUserById,
      },
    },
  })),
}));

const applyInvite = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/aplicar-convite", () => ({ aplicarConvite: applyInvite }));

const ORG = "22222222-2222-4222-8222-222222222222";
const INVITE_ID = "11111111-1111-4111-8111-111111111111";
const EMAIL = "convidada@empresa.test";
const PASSWORD = "SenhaForte!2026";

function inviteFor(email: string, exp = Math.floor(Date.now() / 1000) + 3600) {
  return signInviteToken({ invite_id: INVITE_ID, email, organization_id: ORG, role: "agent", exp });
}

async function run(email: string, token: string) {
  const { completeInviteSignup } = await import("./invite-signup");
  return completeInviteSignup({
    email,
    password: PASSWORD,
    fullName: "Convidada da Silva",
    inviteToken: token,
    requestId: "req-1",
  });
}

function expectNothingWritten() {
  expect(admin.createUser).not.toHaveBeenCalled();
  expect(admin.updateUserById).not.toHaveBeenCalled();
  expect(applyInvite).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetModules();
  for (const f of [admin.createUser, admin.deleteUser, admin.listUsers, admin.updateUserById, applyInvite]) {
    f.mockReset();
  }
  admin.tables = {};
  applyInvite.mockResolvedValue({ ok: true, membershipId: "m-1", mudou: true });
  admin.deleteUser.mockResolvedValue({ error: null });
  admin.updateUserById.mockResolvedValue({ data: { user: {} }, error: null });
});

describe("completeInviteSignup — the happy path", () => {
  it("creates the account CONFIRMED and applies the invite in the same call", async () => {
    admin.createUser.mockResolvedValue({ data: { user: { id: "u-1" } }, error: null });
    const token = inviteFor(EMAIL);

    const result = await run(EMAIL, token);

    expect(result).toEqual({ ok: true, userId: "u-1", created: true });
    expect(admin.createUser).toHaveBeenCalledWith({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      // No `invite_token` left behind: `/auth/callback` would read it again later.
      user_metadata: { full_name: "Convidada da Silva" },
    });
    expect(applyInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u-1",
        payload: expect.objectContaining({ organization_id: ORG, invite_id: INVITE_ID, email: EMAIL }),
      }),
    );
  });

  it("case and spaces in the typed email do not matter: same address", async () => {
    admin.createUser.mockResolvedValue({ data: { user: { id: "u-2" } }, error: null });

    const result = await run("  Convidada@Empresa.Test ", inviteFor(EMAIL));

    expect(result.ok).toBe(true);
    expect(admin.createUser).toHaveBeenCalledWith(expect.objectContaining({ email: EMAIL }));
  });
});

describe("completeInviteSignup — spoofing never yields a confirmed account", () => {
  it("someone else's token pasted into my signup: refused, nothing created", async () => {
    // The attack `convite-no-signup.ts` exists for: I hold the link that was
    // sent to the victim and register MY address with it.
    const victimToken = inviteFor(EMAIL);

    const result = await run("atacante@fora.test", victimToken);

    expect(result).toEqual({ ok: false, reason: "invalid_invite" });
    expectNothingWritten();
  });

  it("a token re-signed with another secret (forged org or role): refused", async () => {
    const body = Buffer.from(
      JSON.stringify({
        invite_id: INVITE_ID,
        email: EMAIL,
        organization_id: ORG,
        role: "admin",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url");
    const sig = createHmac("sha256", "not-our-secret").update(body).digest("base64url");

    const result = await run(EMAIL, `${body}.${sig}`);

    expect(result).toEqual({ ok: false, reason: "invalid_invite" });
    expectNothingWritten();
  });

  it("a valid token with its payload edited (role escalated): refused", async () => {
    const [body, sig] = inviteFor(EMAIL).split(".");
    const payload = JSON.parse(Buffer.from(body!, "base64url").toString());
    const edited = Buffer.from(JSON.stringify({ ...payload, role: "admin" })).toString("base64url");

    const result = await run(EMAIL, `${edited}.${sig}`);

    expect(result).toEqual({ ok: false, reason: "invalid_invite" });
    expectNothingWritten();
  });

  it("an expired token: refused", async () => {
    const result = await run(EMAIL, inviteFor(EMAIL, Math.floor(Date.now() / 1000) - 60));

    expect(result).toEqual({ ok: false, reason: "invalid_invite" });
    expectNothingWritten();
  });

  it("garbage instead of a token: refused", async () => {
    const result = await run(EMAIL, "not-a-token");

    expect(result).toEqual({ ok: false, reason: "invalid_invite" });
    expectNothingWritten();
  });

  it("an invite revoked on the Team screen: refused BEFORE creating the account", async () => {
    admin.tables["team_invites"] = { data: { revoked_at: "2026-10-09T10:00:00Z" }, error: null };

    const result = await run(EMAIL, inviteFor(EMAIL));

    expect(result).toEqual({ ok: false, reason: "invite_revoked" });
    expectNothingWritten();
  });

  it("CONTROL — the same token with the right email goes through (the refusals are not blanket)", async () => {
    admin.createUser.mockResolvedValue({ data: { user: { id: "u-3" } }, error: null });

    expect((await run(EMAIL, inviteFor(EMAIL))).ok).toBe(true);
  });
});

describe("completeInviteSignup — failures leave no half-made account", () => {
  it("invite fails after the account was created: the account is deleted", async () => {
    admin.createUser.mockResolvedValue({ data: { user: { id: "u-4" } }, error: null });
    applyInvite.mockResolvedValue({ ok: false, motivo: "internal_error" });

    const result = await run(EMAIL, inviteFor(EMAIL));

    expect(result).toEqual({ ok: false, reason: "accept_failed" });
    expect(admin.deleteUser).toHaveBeenCalledWith("u-4");
  });

  it("the database refuses the invite (revoked membership): reported as revoked, account deleted", async () => {
    admin.createUser.mockResolvedValue({ data: { user: { id: "u-5" } }, error: null });
    applyInvite.mockResolvedValue({ ok: false, motivo: "invalid_or_expired" });

    const result = await run(EMAIL, inviteFor(EMAIL));

    expect(result).toEqual({ ok: false, reason: "invite_revoked" });
    expect(admin.deleteUser).toHaveBeenCalledWith("u-5");
  });

  it("GoTrue rate limit: reported as such", async () => {
    admin.createUser.mockResolvedValue({ data: null, error: { message: "too many", status: 429 } });

    expect(await run(EMAIL, inviteFor(EMAIL))).toEqual({ ok: false, reason: "rate_limited" });
  });
});

describe("completeInviteSignup — the email already has an account", () => {
  const exists = { data: null, error: { message: "already been registered", code: "email_exists", status: 422 } };

  it("never confirmed (the 2026-10-09 case): the invite confirms it and sets the password", async () => {
    admin.createUser.mockResolvedValue(exists);
    admin.listUsers
      .mockResolvedValueOnce({
        data: {
          users: [
            {
              id: "u-old",
              email: EMAIL,
              email_confirmed_at: null,
              user_metadata: { invite_token: "old", locale: "pt-BR" },
            },
          ],
        },
        error: null,
      });

    const result = await run(EMAIL, inviteFor(EMAIL));

    expect(result).toEqual({ ok: true, userId: "u-old", created: false });
    expect(applyInvite).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-old" }));
    expect(admin.updateUserById).toHaveBeenCalledWith("u-old", {
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { locale: "pt-BR", invite_token: null, full_name: "Convidada da Silva" },
    });
    // Membership before confirmation: a failed invite must not confirm anything.
    expect(applyInvite.mock.invocationCallOrder[0]!).toBeLessThan(
      admin.updateUserById.mock.invocationCallOrder[0]!,
    );
  });

  it("never confirmed, but the invite fails: the account is left untouched", async () => {
    admin.createUser.mockResolvedValue(exists);
    admin.listUsers.mockResolvedValueOnce({
      data: { users: [{ id: "u-old", email: EMAIL, email_confirmed_at: null, user_metadata: {} }] },
      error: null,
    });
    applyInvite.mockResolvedValue({ ok: false, motivo: "internal_error" });

    expect(await run(EMAIL, inviteFor(EMAIL))).toEqual({ ok: false, reason: "accept_failed" });
    expect(admin.updateUserById).not.toHaveBeenCalled();
  });

  it("CONFIRMED account: never taken over — `account_exists`, password untouched", async () => {
    // A confirmed account has a mailbox owner who proved it. Holding the invite
    // link must not reset their password nor join them anywhere.
    admin.createUser.mockResolvedValue(exists);
    admin.listUsers.mockResolvedValueOnce({
      data: {
        users: [{ id: "u-real", email: EMAIL, email_confirmed_at: "2026-01-01T00:00:00Z", user_metadata: {} }],
      },
      error: null,
    });

    expect(await run(EMAIL, inviteFor(EMAIL))).toEqual({ ok: false, reason: "account_exists" });
    expect(admin.updateUserById).not.toHaveBeenCalled();
    expect(applyInvite).not.toHaveBeenCalled();
  });

  it("not found in the directory: `account_exists`, never a takeover", async () => {
    admin.createUser.mockResolvedValue(exists);
    admin.listUsers.mockResolvedValue({ data: { users: [] }, error: null });

    expect(await run(EMAIL, inviteFor(EMAIL))).toEqual({ ok: false, reason: "account_exists" });
    expect(admin.updateUserById).not.toHaveBeenCalled();
  });
});

describe("completeInviteSignup — review hardening", () => {
  const exists = { data: null, error: { message: "already been registered", code: "email_exists", status: 422 } };
  const unconfirmed = (id = "u-old") => ({
    data: { users: [{ id, email: EMAIL, email_confirmed_at: null, user_metadata: {} }] },
    error: null,
  });

  it("the invite row cannot be read: fails CLOSED, nothing created", async () => {
    admin.tables["team_invites"] = { data: null, error: { message: "pooler timeout" } };

    const result = await run(EMAIL, inviteFor(EMAIL));

    expect(result).toMatchObject({ ok: false, reason: "create_failed" });
    expectNothingWritten();
  });

  it("an aplicarConvite THROW takes the rollback path too", async () => {
    admin.createUser.mockResolvedValue({ data: { user: { id: "u-throw" } }, error: null });
    applyInvite.mockRejectedValue(new Error("cookies() outside a request"));

    const result = await run(EMAIL, inviteFor(EMAIL));

    expect(result).toMatchObject({ ok: false, reason: "accept_failed" });
    expect(admin.deleteUser).toHaveBeenCalledWith("u-throw");
  });

  describe("a spent invite (already accepted)", () => {
    it("never creates a new account, even when the old one is gone", async () => {
      // Accepted, then the account was deleted: a forwarded link must not bring
      // it back without the mailbox.
      admin.tables["team_invites"] = {
        data: { revoked_at: null, accepted_at: "2026-10-09T20:00:00Z", accepted_by: "u-gone" },
        error: null,
      };
      admin.listUsers.mockResolvedValue({ data: { users: [] }, error: null });

      expect(await run(EMAIL, inviteFor(EMAIL))).toEqual({ ok: false, reason: "invalid_invite" });
      expectNothingWritten();
    });

    it("does not let ANOTHER unconfirmed account use it", async () => {
      admin.tables["team_invites"] = {
        data: { revoked_at: null, accepted_at: "2026-10-09T20:00:00Z", accepted_by: "u-someone-else" },
        error: null,
      };
      admin.listUsers.mockResolvedValueOnce(unconfirmed("u-old"));

      expect(await run(EMAIL, inviteFor(EMAIL))).toEqual({ ok: false, reason: "invalid_invite" });
      expectNothingWritten();
    });

    it("finishes the half-done attempt of the account that accepted it", async () => {
      // Previous attempt: invite applied, then the confirmation failed.
      admin.tables["team_invites"] = {
        data: { revoked_at: null, accepted_at: "2026-10-09T20:00:00Z", accepted_by: "u-old" },
        error: null,
      };
      admin.tables["user_organizations"] = { data: [{ organization_id: ORG }], error: null };
      admin.listUsers.mockResolvedValueOnce(unconfirmed("u-old"));

      expect(await run(EMAIL, inviteFor(EMAIL))).toEqual({ ok: true, userId: "u-old", created: false });
      expect(admin.createUser).not.toHaveBeenCalled();
      expect(admin.updateUserById).toHaveBeenCalledWith("u-old", expect.objectContaining({ email_confirm: true }));
    });
  });

  describe("an unconfirmed account that already carries authority is never taken over", () => {
    beforeEach(() => {
      admin.createUser.mockResolvedValue(exists);
      admin.listUsers.mockResolvedValueOnce(unconfirmed("u-old"));
    });

    it("platform admin", async () => {
      admin.tables["platform_admins"] = { data: { user_id: "u-old" }, error: null };

      expect(await run(EMAIL, inviteFor(EMAIL))).toEqual({ ok: false, reason: "account_exists" });
      expect(applyInvite).not.toHaveBeenCalled();
      expect(admin.updateUserById).not.toHaveBeenCalled();
    });

    it("a membership in another organization (linked by hand)", async () => {
      admin.tables["user_organizations"] = {
        data: [{ organization_id: "33333333-3333-4333-8333-333333333333" }],
        error: null,
      };

      expect(await run(EMAIL, inviteFor(EMAIL))).toEqual({ ok: false, reason: "account_exists" });
      expect(applyInvite).not.toHaveBeenCalled();
      expect(admin.updateUserById).not.toHaveBeenCalled();
    });

    it("a membership in THIS organization that this invite did not create", async () => {
      // e.g. admin role inserted by SQL; a viewer invite must not hand it over.
      admin.tables["user_organizations"] = { data: [{ organization_id: ORG }], error: null };

      expect(await run(EMAIL, inviteFor(EMAIL))).toEqual({ ok: false, reason: "account_exists" });
      expect(admin.updateUserById).not.toHaveBeenCalled();
    });

    it("the authority lookup fails: fails CLOSED", async () => {
      admin.tables["user_organizations"] = { data: null, error: { message: "boom" } };

      expect(await run(EMAIL, inviteFor(EMAIL))).toMatchObject({ ok: false, reason: "create_failed" });
      expect(admin.updateUserById).not.toHaveBeenCalled();
    });
  });
});
