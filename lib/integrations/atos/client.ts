/**
 * Berseba: thin server-side client of the Atos agenda API (`Berseba/berseba-rbcor`).
 *
 * Read only in this phase. Contract: that repository's `docs/openapi.json` (OpenAPI 3.1); the
 * schemas below are written by hand from it and keep only the fields the CRM uses (Zod drops
 * undeclared keys).
 *
 * Every failure becomes an `AtosApiError` carrying `status` and the API's stable `code`
 * (Problem Details). `status: 0` = no HTTP answer (timeout, network).
 */
import { z } from "zod";

import type { AtosConfig } from "./config";

/** The first slot read walks each instructor's week (1–2 s); later ones come from a 60 s cache. */
export const ATOS_TIMEOUT_MS = 20_000;

export const ATOS_PLANS = ["rbcor", "totalpass_tp2", "totalpass_tp3", "wellhub_silver"] as const;
export const ATOS_PERIODS = ["manha", "tarde"] as const;
export type AtosPlan = (typeof ATOS_PLANS)[number];
export type AtosPeriod = (typeof ATOS_PERIODS)[number];

export class AtosApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AtosApiError";
  }
}

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const slotSchema = z.object({
  id: z.string(),
  date: isoDate,
  start_time: hhmm,
  end_time: hhmm,
  starts_at: z.string(),
  free: z.number().int().min(1),
});
export type AtosSlot = z.infer<typeof slotSchema>;

const bookingSchema = z.object({
  id: z.string(),
  date: isoDate,
  start_time: hhmm,
  end_time: hhmm,
  starts_at: z.string(),
  // A status this CRM does not know yet degrades to `unknown` instead of failing the read.
  status: z
    .enum([
      "scheduled",
      "confirmed",
      "attended",
      "missed",
      "cancelled",
      "rescheduled",
      "makeup",
      "unknown",
    ])
    .catch("unknown"),
  atos_status: z.string().nullable().catch(null),
});
export type AtosBooking = z.infer<typeof bookingSchema>;

const problemSchema = z.object({ code: z.string() });

async function get<T>(
  config: AtosConfig,
  path: string,
  query: Record<string, string | undefined>,
  schema: z.ZodType<T>,
): Promise<T> {
  const url = new URL(config.baseUrl + path);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(name, value);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(ATOS_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new AtosApiError(0, timedOut ? "timeout" : "network_error", `GET ${path} got no answer`);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = problemSchema.safeParse(payload);
    throw new AtosApiError(
      response.status,
      problem.success ? problem.data.code : `http_${response.status}`,
      `GET ${path} answered ${response.status}`,
    );
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new AtosApiError(response.status, "invalid_response", `GET ${path}: unexpected body`);
  }
  return parsed.data;
}

/** `GET /v1/slots`: classes with at least one free place, all instructors together. */
export async function listSlots(
  config: AtosConfig,
  query: { from?: string; to?: string; plan?: AtosPlan; period?: AtosPeriod },
): Promise<AtosSlot[]> {
  const body = await get(
    config,
    "/v1/slots",
    { from: query.from, to: query.to, plan: query.plan, period: query.period },
    z.object({ data: z.array(slotSchema) }),
  );
  return body.data;
}

/** `GET /v1/bookings`: the next classes of the student whose mobile in Atos is `phone`. */
export async function listBookings(
  config: AtosConfig,
  query: { phone: string; from?: string; to?: string },
): Promise<AtosBooking[]> {
  const body = await get(
    config,
    "/v1/bookings",
    { phone: query.phone, from: query.from, to: query.to },
    z.object({ data: z.array(bookingSchema) }),
  );
  return body.data;
}
