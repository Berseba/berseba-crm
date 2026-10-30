/**
 * Berseba: thin server-side client of the Mirae agenda API v1 (Fiore Pilates).
 *
 * Contract: Mirae's `GET /api/v1/openapi.json` (OpenAPI 3.1) and its `docs/integracao-crm.md`;
 * the schemas below are written by hand from it and keep only the fields the CRM uses. Zod drops
 * undeclared keys.
 *
 * Every failure becomes a `MiraeApiError` carrying `status` and the API's stable `code`
 * (`application/problem+json`). `status: 0` = no usable HTTP answer (`timeout`, `network_error`,
 * or a POST whose 2xx body could not be read); for a write that means Mirae may have written it.
 */
import { z } from "zod";

import type { MiraeConfig } from "./config";

/** Booking opens a database transaction on Mirae's side; its guide asks for at least 10 s. */
export const MIRAE_TIMEOUT_MS = 15_000;

export class MiraeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** `already_booked` carries the `starts_at` of the booking the person already has. */
    readonly startsAt?: string,
  ) {
    super(message);
    this.name = "MiraeApiError";
  }
}

const professionalSchema = z.object({ id: z.string(), first_name: z.string() });

const when = {
  starts_at: z.string(),
  ends_at: z.string(),
  date: z.string(),
  time: z.string(),
  weekday: z.string(),
};

const slotSchema = z.object({
  ...when,
  professional: professionalSchema,
  /** Only in a class: spots left with that professional at that time. */
  spots_left: z.number().int().optional(),
});
export type MiraeSlot = z.infer<typeof slotSchema>;

const appointmentSchema = z.object({
  id: z.string(),
  /** `evaluation`, `class` or `other` (a clinical appointment). */
  service: z.string(),
  ...when,
  professional: professionalSchema.nullable(),
  status: z.string(),
  can_change: z.boolean(),
});
export type MiraeAppointment = z.infer<typeof appointmentSchema>;

const personSchema = z
  .object({
    first_name: z.string(),
    /** `lead`, `student` or `former_student`. */
    stage: z.string(),
  })
  .nullable();
export type MiraePerson = z.infer<typeof personSchema>;

const appointmentListSchema = z.object({ person: personSchema, data: z.array(appointmentSchema) });

const availabilitySchema = z.object({ data: z.array(slotSchema) });

const planSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Months of the plan: 1, 3, 6 or 12; `null` for a single session. */
  months: z.number().int().nullable(),
  /** The whole plan, in cents. */
  price_cents: z.number().int(),
  sessions_per_week: z.number().int(),
  total_sessions: z.number().int().nullable(),
});
export type MiraePlan = z.infer<typeof planSchema>;

const bookingRulesSchema = z.object({
  time_zone: z.string(),
  min_notice_hours: z.number().int(),
  horizon_days: z.number().int(),
  cancellation_min_hours: z.number().int(),
});
export type MiraeBookingRules = z.infer<typeof bookingRulesSchema>;

const cancelResultSchema = z.object({ id: z.string(), status: z.literal("cancelled") });

const problemSchema = z.object({ code: z.string(), starts_at: z.string().optional() });

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  idempotencyKey?: string;
}

async function request<T>(
  config: MiraeConfig,
  method: "GET" | "POST",
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  const url = new URL(config.orgUrl + path);
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: "application/json",
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(MIRAE_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new MiraeApiError(
      0,
      timedOut ? "timeout" : "network_error",
      `${method} ${path} got no answer`,
    );
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = problemSchema.safeParse(payload);
    throw new MiraeApiError(
      response.status,
      problem.success ? problem.data.code : `http_${response.status}`,
      `${method} ${path} answered ${response.status}`,
      problem.success ? problem.data.starts_at : undefined,
    );
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    // A POST that answered 2xx did write; an unreadable body (cut by the timeout, or off the
    // contract) is reported as status 0 so the write is retried with the same key and, failing
    // again, handed off as unconfirmed, never as "nothing happened".
    throw new MiraeApiError(
      method === "POST" ? 0 : response.status,
      "invalid_response",
      `${method} ${path}: unexpected body`,
    );
  }
  return parsed.data;
}

const segment = (id: string) => encodeURIComponent(id);

export type MiraeService = "evaluation" | "class";

export async function getBookingRules(config: MiraeConfig): Promise<MiraeBookingRules> {
  return request(config, "GET", "/booking-rules", bookingRulesSchema);
}

export async function listPlans(config: MiraeConfig): Promise<MiraePlan[]> {
  return (await request(config, "GET", "/plans", z.object({ data: z.array(planSchema) }))).data;
}

export async function listAvailability(
  config: MiraeConfig,
  params: {
    service: MiraeService;
    date?: string;
    from?: string;
    to?: string;
    period?: "morning" | "afternoon" | "evening";
    /** Required for a class and for a reschedule: Mirae identifies the person by it. */
    phone?: string;
    name?: string;
    /** Options to reschedule this appointment (same service; no balance needed). */
    appointmentId?: string;
    limit?: number;
  },
): Promise<MiraeSlot[]> {
  const { appointmentId, ...query } = params;
  return (
    await request(config, "GET", "/availability", availabilitySchema, {
      query: { ...query, appointment_id: appointmentId },
    })
  ).data;
}

export async function listAppointments(
  config: MiraeConfig,
  params: { phone: string; name?: string; from?: string; to?: string },
): Promise<{ person: MiraePerson; data: MiraeAppointment[] }> {
  return request(config, "GET", "/appointments", appointmentListSchema, { query: params });
}

export async function createAppointment(
  config: MiraeConfig,
  params: {
    service: MiraeService;
    startsAt: string;
    professionalId?: string;
    phone: string;
    name: string;
    idempotencyKey: string;
  },
): Promise<MiraeAppointment> {
  return request(config, "POST", "/appointments", appointmentSchema, {
    body: {
      service: params.service,
      starts_at: params.startsAt,
      ...(params.professionalId ? { professional_id: params.professionalId } : {}),
      phone: params.phone,
      name: params.name,
    },
    idempotencyKey: params.idempotencyKey,
  });
}

export async function rescheduleAppointment(
  config: MiraeConfig,
  params: {
    appointmentId: string;
    startsAt: string;
    professionalId?: string;
    phone: string;
    name?: string;
    idempotencyKey: string;
  },
): Promise<MiraeAppointment> {
  return request(
    config,
    "POST",
    `/appointments/${segment(params.appointmentId)}/reschedule`,
    appointmentSchema,
    {
      body: {
        starts_at: params.startsAt,
        ...(params.professionalId ? { professional_id: params.professionalId } : {}),
        phone: params.phone,
        ...(params.name ? { name: params.name } : {}),
      },
      idempotencyKey: params.idempotencyKey,
    },
  );
}

export async function cancelAppointment(
  config: MiraeConfig,
  params: { appointmentId: string; phone: string; name?: string; idempotencyKey: string },
): Promise<{ id: string; status: "cancelled" }> {
  return request(
    config,
    "POST",
    `/appointments/${segment(params.appointmentId)}/cancel`,
    cancelResultSchema,
    {
      body: { phone: params.phone, ...(params.name ? { name: params.name } : {}) },
      idempotencyKey: params.idempotencyKey,
    },
  );
}
