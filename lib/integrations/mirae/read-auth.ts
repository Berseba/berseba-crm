/**
 * Berseba: who may call the Mirae read routes (`/api/v1/mirae/*`).
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
import {
  McpAuthError,
  ensureRole,
  ensureScope,
  extractBearer,
  validateBearerToken,
} from "@/lib/mcp/auth";
import { JANELA_SEGUNDOS, TETO_POR_ORGANIZACAO, TETO_POR_TOKEN } from "@/lib/mcp/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export type MiraeReadAuth =
  | { ok: true; organizationId: string; supabase: SupabaseClient }
  | { ok: false; response: Response };

const BUCKET = "mirae-read";

/** Same codes as `/api/v1/contacts`: a token without the scope or the rank is `forbidden_role`. */
const ERROR_CODE_BY_STATUS: Record<number, string> = {
  401: "unauthenticated",
  403: "forbidden_role",
  429: "rate_limited",
};

export async function authorizeMiraeRead(
  authHeader: string | null,
  requestId: string,
): Promise<MiraeReadAuth> {
  if (!extractBearer(authHeader)) {
    return {
      ok: false,
      response: fail("unauthenticated", "Missing or malformed Authorization header.", 401, {
        requestId,
      }),
    };
  }

  let auth;
  try {
    auth = await validateBearerToken(authHeader);
    ensureScope(auth.scopes, "mcp:read");
    ensureRole(auth.role, "viewer");
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
    `${BUCKET}:tok:${auth.apiTokenId}`,
    TETO_POR_TOKEN,
    JANELA_SEGUNDOS,
  );
  const perOrg = perToken.allowed
    ? await checkRateLimit(
        `${BUCKET}:org:${auth.organizationId}`,
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

  return { ok: true, organizationId: auth.organizationId, supabase: createAdminClient() };
}
