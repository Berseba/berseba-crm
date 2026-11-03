/**
 * Berseba: who may call the Mirae routes (`/api/v1/mirae/*`): the reads (`mcp:read`, `viewer`)
 * and the milestone write (`mcp:write`, `agent`, the same bar as the MCP `crm_move_lead_stage`).
 *
 * Mirae is a server: it calls with `Authorization: Bearer dsk_…` and nothing else, so there is no
 * session branch (unlike `lib/api/auth-dual.ts`). The token is checked by `validateBearerToken`,
 * the same authenticator `/api/mcp` and `/api/v1/contacts` use, and `organization_id` comes from
 * the TOKEN ROW, never from the query.
 *
 * Missing header or bad token → 401; valid token without `mcp:read` (or below `viewer`) → 403.
 * The routes are in `PUBLIC_PATHS` (the proxy does not decide), so nothing upstream counts the
 * calls: the read ceilings of the MCP (per token and per organization, `lib/mcp/rate-limit.ts`)
 * are applied here, in their own buckets, so a paging loop does not eat the MCP's quota.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail } from "@/lib/api/wrappers";
import { McpAuthError, ensureRole, ensureScope, validateBearerToken } from "@/lib/mcp/auth";
import { JANELA_SEGUNDOS, TETO_POR_ORGANIZACAO, TETO_POR_TOKEN } from "@/lib/mcp/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export type MiraeAuth =
  | { ok: true; organizationId: string; apiTokenId: string; supabase: SupabaseClient }
  | { ok: false; response: Response };

/** Reads and writes count in separate buckets: a paging loop never eats the milestone quota. */
const READ = { scope: "mcp:read", role: "viewer", bucket: "mirae-read" } as const;
const WRITE = { scope: "mcp:write", role: "agent", bucket: "mirae-write" } as const;

/** Same codes as `/api/v1/contacts`: a token without the scope or the rank is `forbidden_role`. */
const ERROR_CODE_BY_STATUS: Record<number, string> = {
  401: "unauthenticated",
  403: "forbidden_role",
  429: "rate_limited",
};

export function authorizeMiraeRead(
  authHeader: string | null,
  requestId: string,
): Promise<MiraeAuth> {
  return authorizeMirae(authHeader, requestId, READ);
}

export function authorizeMiraeWrite(
  authHeader: string | null,
  requestId: string,
): Promise<MiraeAuth> {
  return authorizeMirae(authHeader, requestId, WRITE);
}

async function authorizeMirae(
  authHeader: string | null,
  requestId: string,
  rule: { scope: string; role: "viewer" | "agent"; bucket: string },
): Promise<MiraeAuth> {
  // No pre-check of the header: `validateBearerToken` answers 401 on a missing one itself and,
  // unlike a shortcut here, counts it as a failed attempt like the MCP does.
  let auth;
  try {
    auth = await validateBearerToken(authHeader);
    ensureScope(auth.scopes, rule.scope);
    ensureRole(auth.role, rule.role);
  } catch (err) {
    if (err instanceof McpAuthError) {
      const code = err.codigo ?? ERROR_CODE_BY_STATUS[err.httpStatus] ?? "internal_error";
      return { ok: false, response: fail(code, err.message, err.httpStatus, { requestId }) };
    }
    throw err;
  }

  // Sequential on purpose: `checkRateLimit` increments when asked, and a call already refused by
  // the token ceiling must not spend the organization's quota.
  const perToken = await checkRateLimit(
    `${rule.bucket}:tok:${auth.apiTokenId}`,
    TETO_POR_TOKEN,
    JANELA_SEGUNDOS,
  );
  const perOrg = perToken.allowed
    ? await checkRateLimit(
        `${rule.bucket}:org:${auth.organizationId}`,
        TETO_POR_ORGANIZACAO,
        JANELA_SEGUNDOS,
      )
    : perToken;
  if (!perOrg.allowed) {
    return {
      ok: false,
      response: fail("rate_limited", "Too many requests.", 429, {
        requestId,
        headers: { "Retry-After": String(JANELA_SEGUNDOS) },
      }),
    };
  }

  return {
    ok: true,
    organizationId: auth.organizationId,
    apiTokenId: auth.apiTokenId,
    supabase: createAdminClient(),
  };
}
