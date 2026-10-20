/**
 * Berseba: the 90-day cleanup of ad clicks that never became a conversation.
 *
 * `google_ads_click_refs` and `meta_ads_click_refs` get one row per click on a
 * capture address (`app/api/v1/anuncios/{google,meta}/[org]`). A row is
 * stamped (`matched_at`) when the WhatsApp message carrying its ref arrives. A
 * click that is never stamped, the person who closed the page or never sent
 * the message, stayed in the table forever: migrations 0306 and 0381 left it
 * as declared debt, and `query_raw` holds the campaign parameters of someone
 * who never talked to the clinic.
 *
 * Only rows with `matched_at is null` and `created_at` older than the cutoff
 * are deleted. A matched click is the attribution of a real contact and is
 * never touched: the delete re-checks `matched_at is null`, so a click that
 * gets matched between the two steps survives.
 *
 * Side effect to know: `fn_metricas_links_rastreaveis` (tracked links, 0437)
 * counts `clicks` as rows of these tables, so the click count of a tracked
 * link stops growing past 90 days for the clicks that never became a contact.
 * Contacts and leads, which come from matched rows, are unaffected.
 *
 * No migration: no index covers `(matched_at, created_at)`, so each select
 * scans the table. These tables hold one row per ad click, which is small for
 * a clinic. Add an index only if the select shows up as slow.
 *
 * Wired into the daily `app/api/v1/cron/data-retention` with one hook line.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { IDS_POR_LOTE } from "@/lib/supabase/em-lotes";

/**
 * The Fiore privacy page promises 90 days for a click that never became a
 * conversation, and Google Ads only accepts offline conversions for clicks up
 * to 90 days old, so an unmatched click older than that has no use.
 */
export const UNMATCHED_CLICK_RETENTION_DAYS = 90;

/** Rows selected, and so deleted, per batch. */
export const CLICK_RETENTION_BATCH_SIZE = 500;

/** Batches per table per run: a backlog drains over a few days, never in one request. */
export const CLICK_RETENTION_MAX_BATCHES = 20;

export const CLICK_REF_TABLES = ["google_ads_click_refs", "meta_ads_click_refs"] as const;
export type ClickRefTable = (typeof CLICK_REF_TABLES)[number];
export type ClickCounts = Record<ClickRefTable, number>;

export interface UnmatchedClickCleanup {
  deleted: ClickCounts;
  /** One message per table that failed. The other table is still cleaned. */
  failures: string[];
}

const emptyCounts = (): ClickCounts => ({ google_ads_click_refs: 0, meta_ads_click_refs: 0 });

/**
 * Drains one table, adding to `deleted` as it goes so a failure in a later
 * batch still reports what the earlier ones removed.
 */
async function deleteUnmatchedFrom(
  admin: SupabaseClient,
  table: ClickRefTable,
  cutoff: string,
  deleted: ClickCounts,
): Promise<void> {
  for (let batch = 0; batch < CLICK_RETENTION_MAX_BATCHES; batch += 1) {
    const { data: selected, error: selectError } = await admin
      .from(table)
      .select("id")
      .is("matched_at", null)
      .lt("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(CLICK_RETENTION_BATCH_SIZE);
    if (selectError) throw new Error(`${table}: ${selectError.message}`);

    const ids = ((selected ?? []) as { id: string }[]).map((row) => row.id);
    if (ids.length === 0) return;

    // By id list, in chunks of `IDS_POR_LOTE`, one after the other: the
    // PostgREST filter travels in the URL, and 500 uuids are ~19 KB, over the
    // 8 KB the gateway in front of it accepts (414). Sequential, so a failure
    // keeps an exact count of what the earlier chunks removed.
    for (let start = 0; start < ids.length; start += IDS_POR_LOTE) {
      const { data: removed, error: deleteError } = await admin
        .from(table)
        .delete()
        .in("id", ids.slice(start, start + IDS_POR_LOTE))
        .is("matched_at", null)
        .select("id");
      if (deleteError) throw new Error(`${table}: ${deleteError.message}`);
      deleted[table] += (removed ?? []).length;
    }

    // A short batch means the old end of the table is exhausted.
    if (ids.length < CLICK_RETENTION_BATCH_SIZE) return;
  }
}

/**
 * Deletes the unmatched clicks older than `UNMATCHED_CLICK_RETENTION_DAYS`
 * from both tables. A table that fails does not stop the other one: its
 * message goes to `failures`.
 */
export async function deleteUnmatchedClicks(
  admin: SupabaseClient,
  now: Date = new Date(),
): Promise<UnmatchedClickCleanup> {
  const cutoff = new Date(
    now.getTime() - UNMATCHED_CLICK_RETENTION_DAYS * 86_400_000,
  ).toISOString();
  const deleted = emptyCounts();
  const failures: string[] = [];

  for (const table of CLICK_REF_TABLES) {
    try {
      await deleteUnmatchedFrom(admin, table, cutoff, deleted);
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { deleted, failures };
}

/** What the cron adds to its response for this step. */
export interface ClickRetentionReport {
  unmatched_clicks_deleted: ClickCounts;
  unmatched_clicks_failures: number;
}

/**
 * The step as the daily cron runs it. It never throws, so it cannot stop the
 * steps around it: a failure is logged, written to the audit trail like the
 * cron's own (`retention.sweep_run` with `falhou: true`) and reported in the
 * response. A run that deleted nothing leaves no trail, like the other steps.
 */
export async function runUnmatchedClickRetention(
  requestId: string,
  admin?: SupabaseClient,
): Promise<ClickRetentionReport> {
  let cleanup: UnmatchedClickCleanup;
  try {
    cleanup = await deleteUnmatchedClicks(admin ?? createAdminClient());
  } catch (err) {
    cleanup = {
      deleted: emptyCounts(),
      failures: [err instanceof Error ? err.message : String(err)],
    };
  }

  for (const failure of cleanup.failures) {
    logger.error("[data-retention] unmatched ad click cleanup failed", {
      error: failure,
      requestId,
    });
  }

  const total = CLICK_REF_TABLES.reduce((sum, table) => sum + cleanup.deleted[table], 0);
  if (total > 0 || cleanup.failures.length > 0) {
    void audit({
      action: "retention.sweep_run",
      organizationId: null,
      bypassedRls: true,
      metadata: {
        origem: "ad-click-refs",
        retention_days: UNMATCHED_CLICK_RETENTION_DAYS,
        unmatched_clicks_deleted: cleanup.deleted,
        ...(cleanup.failures.length > 0
          ? { falhou: true, erro: cleanup.failures.join("; ").slice(0, 300) }
          : {}),
      },
      requestId,
    });
  }

  return {
    unmatched_clicks_deleted: cleanup.deleted,
    unmatched_clicks_failures: cleanup.failures.length,
  };
}
