/**
 * Berseba: thin server-side client of the Atos agenda API (`Berseba/berseba-rbcor`).
 *
 * Contract: that repository's `docs/openapi.json` (OpenAPI 3.1); the schemas below are written
 * by hand from it and keep only the fields the CRM uses (Zod drops undeclared keys).
 *
 * Every failure becomes an `AtosApiError` carrying `status`, the API's stable `code` and, when
 * sent, its `detail` (Problem Details). `status: 0` = no HTTP answer (timeout, network); for a
 * write that means Atos may have written it, like `atos_write_unconfirmed`.
 *
 * A write that answered 2xx DID happen: its body is parsed leniently, so an unexpected shape
 * never turns a done write into a failure the agent would retry or hand off as "not done".
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
    /** The API's `detail`, in Portuguese for `rule_violation`. Never carries student data. */
    readonly detail?: string,
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

const problemSchema = z.object({ code: z.string(), detail: z.string().max(500).optional() });

async function send(
  path: string,
  init: RequestInit,
): Promise<{ response: Response; payload: unknown }> {
  const method = init.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      signal: AbortSignal.timeout(ATOS_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new AtosApiError(
      0,
      timedOut ? "timeout" : "network_error",
      `${method} ${new URL(path).pathname} got no answer`,
    );
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = problemSchema.safeParse(payload);
    throw new AtosApiError(
      response.status,
      problem.success ? problem.data.code : `http_${response.status}`,
      `${method} ${new URL(path).pathname} answered ${response.status}`,
      problem.success ? problem.data.detail : undefined,
    );
  }
  return { response, payload };
}

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
  const { response, payload } = await send(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" },
  });
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

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

const writeResultSchema = z.object({
  booking: bookingSchema.optional().catch(undefined),
  makeup_eligible: z.boolean().optional().catch(undefined),
});
export type AtosWriteResult = z.infer<typeof writeResultSchema>;

/**
 * `POST` with the `Idempotency-Key` the tool derived for this write. Never retried here: a lost
 * answer may mean Atos wrote it, and only the front desk can check.
 */
async function post(
  config: AtosConfig,
  path: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<AtosWriteResult> {
  const { payload } = await send(config.baseUrl + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  const parsed = writeResultSchema.safeParse(payload);
  return parsed.success ? parsed.data : {};
}

const withoutUndefined = (body: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));

/** `POST /v1/bookings/{id}/cancel`: cancel a class or report an absence (both "Desmarcado"). */
export function cancelBooking(
  config: AtosConfig,
  input: { bookingId: string; phone: string; reason?: string; idempotencyKey: string },
): Promise<AtosWriteResult> {
  return post(
    config,
    `/v1/bookings/${encodeURIComponent(input.bookingId)}/cancel`,
    withoutUndefined({ phone: input.phone, reason: input.reason }),
    input.idempotencyKey,
  );
}

/** `POST /v1/bookings/{id}/reschedule`. */
export function rescheduleBooking(
  config: AtosConfig,
  input: { bookingId: string; phone: string; slotId: string; idempotencyKey: string },
): Promise<AtosWriteResult> {
  return post(
    config,
    `/v1/bookings/${encodeURIComponent(input.bookingId)}/reschedule`,
    { phone: input.phone, slot_id: input.slotId },
    input.idempotencyKey,
  );
}

/** `POST /v1/makeups`: the make-up class of a cancelled one. */
export function bookMakeup(
  config: AtosConfig,
  input: { phone: string; missedBookingId: string; slotId: string; idempotencyKey: string },
): Promise<AtosWriteResult> {
  return post(
    config,
    "/v1/makeups",
    { phone: input.phone, missed_booking_id: input.missedBookingId, slot_id: input.slotId },
    input.idempotencyKey,
  );
}

/** `POST /v1/bookings`: a student who already exists books a class. */
export function bookClass(
  config: AtosConfig,
  input: { phone: string; slotId: string; idempotencyKey: string },
): Promise<AtosWriteResult> {
  return post(
    config,
    "/v1/bookings",
    { phone: input.phone, slot_id: input.slotId },
    input.idempotencyKey,
  );
}

/** `POST /v1/trial-bookings`: the bridge registers the student and books the first class. */
export function bookTrial(
  config: AtosConfig,
  input: {
    phone: string;
    name: string;
    birthDate: string;
    slotId: string;
    plan: AtosPlan;
    pregnant?: boolean;
    needs?: string;
    idempotencyKey: string;
  },
): Promise<AtosWriteResult> {
  return post(
    config,
    "/v1/trial-bookings",
    withoutUndefined({
      phone: input.phone,
      name: input.name,
      birth_date: input.birthDate,
      slot_id: input.slotId,
      plan: input.plan,
      pregnant: input.pregnant,
      needs: input.needs,
    }),
    input.idempotencyKey,
  );
}
