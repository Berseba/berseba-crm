/**
 * Berseba: thin server-side client of the avec agenda API (`Berseba/berseba-mayara-morales`).
 *
 * Contract: that repository's `docs/openapi.json` (OpenAPI 3.1); the schemas below are written
 * by hand from it and keep only the fields the CRM uses. Zod drops undeclared keys, so
 * `client_name` and `client_phone` never leave this module.
 *
 * Every failure becomes an `AvecApiError` carrying `status` and the API's stable `code`
 * (Problem Details). `status: 0` = no HTTP answer (timeout, network); for a write that means
 * avec may have written it, like `avec_write_unconfirmed`.
 */
import { z } from "zod";

import type { AvecConfig } from "./config";

/** The API logs in to avec again when its session expires (~35 s, once per session). */
export const AVEC_TIMEOUT_MS = 60_000;

export class AvecApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AvecApiError";
  }
}

const text = z.string().nullable();

const appointmentSchema = z.object({
  id: z.string(),
  service_id: z.string(),
  service: text,
  professional_id: z.string(),
  professional: text,
  date: z.string(),
  start_time: z.string(),
  end_time: z.string(),
  starts_at: z.string(),
  status: text,
  // 1 Agendado, 1.5 Confirmado, 2 Aguardando, 3 Em Atendimento, 3.5 Finalizado, 4 Pago, 0.6 Faltou
  // (cancelled ones are left out by the API). Optional: older API versions did not send it.
  status_name: text.optional(),
});
export type AvecAppointment = z.infer<typeof appointmentSchema>;

const slotSchema = z.object({
  id: z.string(),
  professional_id: z.string(),
  service_id: z.string(),
  date: z.string(),
  start_time: z.string(),
  end_time: z.string(),
  starts_at: z.string(),
  // How the slot sits among the professional's bookings that day (Berseba/berseba-mayara-morales#27).
  bookings_that_day: z.number().int().optional(),
  gap_before_minutes: z.number().int().nullable().optional(),
  gap_after_minutes: z.number().int().nullable().optional(),
});
export type AvecSlot = z.infer<typeof slotSchema>;

const professionalSchema = z.object({
  id: z.string(),
  name: text,
  services: z.array(
    z.object({
      id: z.string(),
      name: text,
      duration_minutes: z.number().int().nullable(),
    }),
  ),
});
export type AvecProfessional = z.infer<typeof professionalSchema>;

const cancelResultSchema = z.object({ id: z.string(), status: z.string() });

const problemSchema = z.object({ code: z.string(), detail: z.string().optional() });

interface RequestOptions {
  query?: Record<string, string | undefined>;
  body?: unknown;
  idempotencyKey?: string;
}

async function request<T>(
  config: AvecConfig,
  method: "GET" | "POST",
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  const url = new URL(config.baseUrl + path);
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(name, value);
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
      signal: AbortSignal.timeout(AVEC_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new AvecApiError(
      0,
      timedOut ? "timeout" : "network_error",
      `${method} ${path} got no answer`,
    );
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = problemSchema.safeParse(payload);
    throw new AvecApiError(
      response.status,
      problem.success ? problem.data.code : `http_${response.status}`,
      `${method} ${path} answered ${response.status}`,
    );
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new AvecApiError(
      response.status,
      "invalid_response",
      `${method} ${path}: unexpected body`,
    );
  }
  return parsed.data;
}

const list = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item) });

export async function listProfessionals(config: AvecConfig): Promise<AvecProfessional[]> {
  return (await request(config, "GET", "/v1/professionals", list(professionalSchema))).data;
}

export async function listAppointments(
  config: AvecConfig,
  params: { phone: string; from?: string; to?: string },
): Promise<AvecAppointment[]> {
  return (
    await request(config, "GET", "/v1/appointments", list(appointmentSchema), { query: params })
  ).data;
}

export async function getAppointment(
  config: AvecConfig,
  params: { id: string; phone: string },
): Promise<AvecAppointment> {
  return request(
    config,
    "GET",
    `/v1/appointments/${encodeURIComponent(params.id)}`,
    appointmentSchema,
    { query: { phone: params.phone } },
  );
}

export async function listAvailability(
  config: AvecConfig,
  params: { service_id: string; professional_id?: string; from?: string; to?: string },
): Promise<AvecSlot[]> {
  return (await request(config, "GET", "/v1/availability", list(slotSchema), { query: params }))
    .data;
}

export async function cancelAppointment(
  config: AvecConfig,
  params: { appointmentId: string; phone: string; reason?: string; idempotencyKey: string },
): Promise<{ id: string; status: string }> {
  return request(
    config,
    "POST",
    `/v1/appointments/${encodeURIComponent(params.appointmentId)}/cancel`,
    cancelResultSchema,
    {
      body: { phone: params.phone, ...(params.reason ? { reason: params.reason } : {}) },
      idempotencyKey: params.idempotencyKey,
    },
  );
}

/** `POST /v1/appointments` (Berseba/berseba-mayara-morales#19); answers 501 until switched on. */
export async function createAppointment(
  config: AvecConfig,
  params: { phone: string; slotId: string; note?: string; idempotencyKey: string },
): Promise<AvecAppointment> {
  return request(config, "POST", "/v1/appointments", appointmentSchema, {
    body: {
      phone: params.phone,
      slot_id: params.slotId,
      ...(params.note ? { note: params.note } : {}),
    },
    idempotencyKey: params.idempotencyKey,
  });
}

export async function rescheduleAppointment(
  config: AvecConfig,
  params: { appointmentId: string; phone: string; slotId: string; idempotencyKey: string },
): Promise<AvecAppointment> {
  return request(
    config,
    "POST",
    `/v1/appointments/${encodeURIComponent(params.appointmentId)}/reschedule`,
    appointmentSchema,
    {
      body: { phone: params.phone, slot_id: params.slotId },
      idempotencyKey: params.idempotencyKey,
    },
  );
}
