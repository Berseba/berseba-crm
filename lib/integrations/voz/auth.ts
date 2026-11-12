/**
 * Berseba: who may send Voz's call reports (`POST /api/v1/voz/call-ended`): a `dsk_` token with
 * `mcp:write` and at least `agent`, the bar of the MCP's `crm_move_lead_stage` and of the Mirae
 * milestones. The organization comes from the token row. Writes count in their own bucket, so
 * Voz never eats the MCP's or Mirae's quota.
 */
import { authorizeServerBearer, type MiraeAuth } from "@/lib/integrations/mirae/read-auth";
import { TETO_DE_ESCRITA } from "@/lib/mcp/rate-limit";

export function authorizeVozWrite(authHeader: string | null, requestId: string): Promise<MiraeAuth> {
  return authorizeServerBearer(authHeader, requestId, {
    scope: "mcp:write",
    role: "agent",
    bucket: "voz-write",
    perToken: TETO_DE_ESCRITA,
  });
}
