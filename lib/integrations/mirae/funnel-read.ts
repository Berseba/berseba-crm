/**
 * Berseba: the studio's funnel as Mirae reads it (Mirae ADR-073).
 *
 * Mirae shows an end-to-end funnel (lead → evaluation → enrollment) and needs the CRM's entry
 * funnel. One stable route of our own instead of the MCP: the MCP contract is shaped for an agent,
 * moves with upstream and would cost N calls per page.
 *
 * What leaves the CRM is the minimum to count and to link back: ids, dates, status, stage, loss
 * reason, origin (source + campaign), phone in E.164 (Mirae's join key with its students), contact
 * tags and the last message dates. Never a name, e-mail, CPF, message text nor custom fields.
 *
 * Every query is scoped by `organization_id` from the token row: the client is service-role and
 * RLS does not apply. A pipeline of another organization is a 404, the same answer as one that
 * does not exist.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { idsDeContatosPessoais } from "@/app/api/v1/conversations/_handler";
import { env } from "@/lib/env";
import { origemDoContato } from "@/lib/leads/origem-do-contato";

export const PAGE_SIZE = 200;
export const MAX_RANGE_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Ids per `in.(…)` lookup. The ids travel in the PostgREST query string and the gateway caps the
 * request line at 8 KiB (`app/api/v1/conversations/_handler.ts`, `ORCAMENTO_DE_IDS_NA_URL`): 100
 * uuids are ~3.7 KB. It also keeps the conversations lookup far below `max_rows` (1000).
 */
const LOOKUP_CHUNK = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A Postgres `timestamptz` as PostgREST prints it. Nothing else may reach the `or=` filter. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

export const leadsQuerySchema = z
  .object({
    pipeline_id: z.string().regex(UUID, "pipeline_id must be a uuid"),
    created_from: z.string().datetime({ offset: true }),
    created_to: z.string().datetime({ offset: true }),
    cursor: z.string().min(1).max(512).optional(),
  })
  .superRefine((q, ctx) => {
    const from = Date.parse(q.created_from);
    const to = Date.parse(q.created_to);
    if (from >= to) {
      ctx.addIssue({
        code: "custom",
        path: ["created_to"],
        message: "created_to must be after created_from",
      });
    } else if (to - from > MAX_RANGE_DAYS * DAY_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["created_to"],
        message: `range is limited to ${MAX_RANGE_DAYS} days`,
      });
    }
    if (q.cursor !== undefined && decodeCursor(q.cursor) === null) {
      ctx.addIssue({ code: "custom", path: ["cursor"], message: "invalid cursor" });
    }
  });

export type LeadsQuery = z.infer<typeof leadsQuerySchema>;

interface Cursor {
  created_at: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/**
 * The cursor is client input that ends up inside a PostgREST `or=` filter, so both fields are
 * held to their exact shape: a comma or a parenthesis there would rewrite the filter.
 */
export function decodeCursor(raw: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof c.id !== "string" || !UUID.test(c.id)) return null;
    if (typeof c.created_at !== "string" || !TIMESTAMP.test(c.created_at)) return null;
    return { created_at: c.created_at, id: c.id };
  } catch {
    return null;
  }
}

export interface MiraeLead {
  id: string;
  created_at: string;
  closed_at: string | null;
  status: "open" | "won" | "lost";
  stage: { id: string; name: string; is_won: boolean; is_lost: boolean };
  lost_reason: string | null;
  lost_from_stage: { id: string; name: string } | null;
  origin: { source: string; campaign: string | null };
  contact: { phone: string | null; tags: string[] };
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  url: string;
}

export type ListLeadsOutcome =
  { ok: true; data: MiraeLead[]; next_cursor: string | null } | { ok: false; status: 404 };

interface LeadRow {
  id: string;
  created_at: string;
  closed_at: string | null;
  status: string;
  stage_id: string;
  lost_reason: string | null;
  lost_from_stage_id: string | null;
  contact_id: string | null;
  source: string;
  source_metadata: Record<string, unknown> | null;
}
interface StageRow {
  id: string;
  name: string;
  is_won: boolean;
  is_lost: boolean;
}
interface ContactRow {
  id: string;
  phone_number: string | null;
  tags: string[] | null;
  source: string;
  source_metadata: Record<string, unknown> | null;
}
interface ConversationRow {
  contact_id: string;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
}

/** Thrown on a database error; the route turns it into a 500 without the message. */
export class FunnelReadError extends Error {}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += LOOKUP_CHUNK) out.push(items.slice(i, i + LOOKUP_CHUNK));
  return out;
}

/** Runs one `in.(…)` lookup per chunk of ids and concatenates the rows. */
async function lookup<T>(
  ids: string[],
  query: (chunk: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const unique = [...new Set(ids)];
  const results = await Promise.all(chunks(unique).map((chunk) => query(chunk)));
  const rows: T[] = [];
  for (const { data, error } of results) {
    if (error) throw new FunnelReadError(error.message);
    rows.push(...((data ?? []) as T[]));
  }
  return rows;
}

/** The card's address in the CRM: `app/app/leads/[id]/page.tsx` resolves the funnel and redirects. */
export function leadUrl(leadId: string): string {
  return `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/app/leads/${leadId}`;
}

export async function listMiraeLeads(
  supabase: SupabaseClient,
  organizationId: string,
  q: LeadsQuery,
): Promise<ListLeadsOutcome> {
  const pipeline = await supabase
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("id", q.pipeline_id)
    .maybeSingle();
  if (pipeline.error) throw new FunnelReadError(pipeline.error.message);
  if (!pipeline.data) return { ok: false, status: 404 };

  let query = supabase
    .from("crm_leads")
    .select(
      "id, created_at, closed_at, status, stage_id, lost_reason, lost_from_stage_id, contact_id, source, source_metadata",
    )
    .eq("organization_id", organizationId)
    .eq("pipeline_id", q.pipeline_id)
    .gte("created_at", new Date(q.created_from).toISOString())
    .lt("created_at", new Date(q.created_to).toISOString())
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(PAGE_SIZE + 1);

  // Two disjunctions, ANDed inside ONE `or=` tree (`or=(and(or(…),or(…)))`) rather than two
  // `or=` params, so the result does not depend on how PostgREST combines repeated keys.
  const conditions: string[] = [];
  // A personal contact's deals are not listed (spec 21), the same id primitive as
  // `listLeadsHandler`, in the WHERE before the limit so the cursor describes the visible set.
  // Unlike there, `contact_id IS NULL` is kept explicitly: `NOT IN` alone drops the NULLs, and a
  // lead without a contact is still a lead of the funnel.
  const personal = await idsDeContatosPessoais(supabase, organizationId);
  if (personal.length > 0) {
    conditions.push(`or(contact_id.is.null,contact_id.not.in.(${personal.join(",")}))`);
  }
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  if (cursor) {
    conditions.push(
      `or(created_at.gt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.gt.${cursor.id}))`,
    );
  }
  if (conditions.length > 0) query = query.or(`and(${conditions.join(",")})`);

  const { data, error } = await query;
  if (error) throw new FunnelReadError(error.message);
  const rows = (data ?? []) as LeadRow[];
  const page = rows.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  const next_cursor =
    rows.length > PAGE_SIZE && last
      ? encodeCursor({ created_at: last.created_at, id: last.id })
      : null;
  if (page.length === 0) return { ok: true, data: [], next_cursor: null };

  const stageIds = page.flatMap((l) =>
    l.lost_from_stage_id ? [l.stage_id, l.lost_from_stage_id] : [l.stage_id],
  );
  const contactIds = page.flatMap((l) => (l.contact_id ? [l.contact_id] : []));

  const [stages, contacts, conversations] = await Promise.all([
    lookup<StageRow>(stageIds, (ids) =>
      supabase
        .from("crm_stages")
        .select("id, name, is_won, is_lost")
        .eq("organization_id", organizationId)
        .in("id", ids),
    ),
    lookup<ContactRow>(contactIds, (ids) =>
      supabase
        .from("contacts")
        .select("id, phone_number, tags, source, source_metadata")
        .eq("organization_id", organizationId)
        .in("id", ids),
    ),
    lookup<ConversationRow>(contactIds, (ids) =>
      supabase
        .from("conversations")
        .select("contact_id, last_inbound_at, last_outbound_at")
        .eq("organization_id", organizationId)
        .eq("is_group", false)
        .in("contact_id", ids)
        .order("last_message_at", { ascending: false, nullsFirst: false }),
    ),
  ]);

  const stageById = new Map(stages.map((s) => [s.id, s]));
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  // Rows come newest first: the first one seen per contact is its most recent conversation.
  const conversationByContact = new Map<string, ConversationRow>();
  for (const conv of conversations) {
    if (!conversationByContact.has(conv.contact_id))
      conversationByContact.set(conv.contact_id, conv);
  }

  return {
    ok: true,
    next_cursor,
    data: page.map((lead) => {
      const stage = stageById.get(lead.stage_id);
      const lostFrom = lead.lost_from_stage_id ? stageById.get(lead.lost_from_stage_id) : undefined;
      const contact = lead.contact_id ? contactById.get(lead.contact_id) : undefined;
      const conv = lead.contact_id ? conversationByContact.get(lead.contact_id) : undefined;
      // Origin is the contact's (`origemDoContato`, the same reading as the contact screen). A lead
      // without a contact falls back to its own `source`/`source_metadata` through the same rule.
      const origin = contact
        ? origemDoContato(contact.source_metadata, contact.source)
        : origemDoContato(lead.source_metadata, lead.source);
      return {
        id: lead.id,
        created_at: lead.created_at,
        closed_at: lead.closed_at,
        status: lead.status as MiraeLead["status"],
        stage: {
          id: lead.stage_id,
          name: stage?.name ?? "",
          is_won: stage?.is_won ?? false,
          is_lost: stage?.is_lost ?? false,
        },
        lost_reason: lead.lost_reason,
        lost_from_stage: lead.lost_from_stage_id
          ? { id: lead.lost_from_stage_id, name: lostFrom?.name ?? "" }
          : null,
        origin: { source: origin.origem, campaign: origin.campanha },
        contact: { phone: contact?.phone_number ?? null, tags: contact?.tags ?? [] },
        last_inbound_at: conv?.last_inbound_at ?? null,
        last_outbound_at: conv?.last_outbound_at ?? null,
        url: leadUrl(lead.id),
      };
    }),
  };
}

export interface MiraePipeline {
  id: string;
  name: string;
  is_default: boolean;
  stages: Array<{ id: string; name: string; position: number; is_won: boolean; is_lost: boolean }>;
}

/** The organization's live funnels and their live stages, for Mirae's "milestone → stage" mapping. */
export async function listMiraePipelines(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<MiraePipeline[]> {
  const pipelines = await supabase
    .from("crm_pipelines")
    .select("id, name, is_default")
    .eq("organization_id", organizationId)
    .eq("is_archived", false)
    .order("position", { ascending: true })
    .order("name", { ascending: true });
  if (pipelines.error) throw new FunnelReadError(pipelines.error.message);
  const rows = (pipelines.data ?? []) as Array<{ id: string; name: string; is_default: boolean }>;
  if (rows.length === 0) return [];

  const stages = await lookup<StageRow & { pipeline_id: string; position: number }>(
    rows.map((p) => p.id),
    (ids) =>
      supabase
        .from("crm_stages")
        .select("id, pipeline_id, name, position, is_won, is_lost")
        .eq("organization_id", organizationId)
        .eq("is_archived", false)
        .in("pipeline_id", ids)
        .order("position", { ascending: true }),
  );

  const byPipeline = new Map<string, MiraePipeline["stages"]>();
  for (const s of [...stages].sort((a, b) => Number(a.position) - Number(b.position))) {
    const list = byPipeline.get(s.pipeline_id) ?? [];
    list.push({
      id: s.id,
      name: s.name,
      position: Number(s.position),
      is_won: s.is_won,
      is_lost: s.is_lost,
    });
    byPipeline.set(s.pipeline_id, list);
  }
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    is_default: p.is_default,
    stages: byPipeline.get(p.id) ?? [],
  }));
}
