/**
 * Berseba: before a Mirae confirmation reminder runs, ask Mirae whether the appointment is still
 * there (berseba-crm#127, mirae-local#804).
 *
 * Mirae cannot recall a reminder once the CRM answered `scheduled`, and the turn may run hours
 * later (the send window defers it). So, right before the turn, the CRM reads the contact's
 * appointments on that day (`GET /appointments`, the same call as `mirae_my_appointments`) and
 * looks for a `scheduled` one starting at `appointment_start_at`:
 *
 *  - found → `confirmed`, the turn runs;
 *  - Mirae knows the person, the list came back and it is not there (cancelled, moved, no-show)
 *    → `gone`, nothing is sent nor drafted;
 *  - Mirae did not answer → `unavailable`: the automatic turn retries a few times, then falls back
 *    to a draft;
 *  - no Mirae for this organization, no phone, or Mirae does not know the person by either
 *    spelling of the phone (`person: null`) → `unknown`: the automatic reminder becomes a draft.
 *
 * The phone is the CRM contact's; when Mirae finds nobody by it, the phone Mirae itself sent is
 * tried (the two may differ by the Brazilian 9th digit). A `person: null` is never `gone`.
 *
 * Mirae's public API has no holiday read; a holiday is left to Mirae (it does not remind about
 * appointments it closed) and to the briefing.
 */
import type pg from "pg";

import { listAppointments, type MiraeAppointment } from "./client";
import { miraeConfigFor, type MiraeConfig } from "./config";

export type AppointmentCheck = "confirmed" | "gone" | "unknown" | "unavailable";

/** `YYYY-MM-DD` of an instant in Brasília (Mirae's agenda day). */
export function dayInBrasilia(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Pure: is there a `scheduled` appointment starting at that instant? */
export function appointmentStillScheduled(
  appointments: readonly Pick<MiraeAppointment, "starts_at" | "status">[],
  startAtIso: string,
): boolean {
  const at = Date.parse(startAtIso);
  // `starts_at` is Mirae's JSON string, never a `pg` column; `new Date` reads either offset.
  return appointments.some(
    (a) => a.status === "scheduled" && new Date(a.starts_at).getTime() === at,
  );
}

export interface PrecheckPorts {
  configFor: (organizationId: string) => MiraeConfig | null;
  list: typeof listAppointments;
}

const DEFAULT_PORTS: PrecheckPorts = { configFor: miraeConfigFor, list: listAppointments };

export async function checkMiraeAppointment(
  pool: Pick<pg.Pool, "query">,
  input: {
    organizationId: string;
    contactId: string;
    appointmentStartAt: string;
    /** Digits of the phone Mirae sent with the reminder. */
    miraePhone?: string | null;
  },
  ports: PrecheckPorts = DEFAULT_PORTS,
): Promise<AppointmentCheck> {
  const startAt = new Date(input.appointmentStartAt);
  if (Number.isNaN(startAt.getTime())) return "unknown";
  const config = ports.configFor(input.organizationId);
  if (!config) return "unknown";
  const { rows } = await pool.query<{ phone_number: string | null }>(
    "select phone_number from contacts where organization_id = $1 and id = $2",
    [input.organizationId, input.contactId],
  );
  // Same rule as the Mirae tools: digits only, never anything the model wrote.
  const phones = [
    ...new Set(
      [rows[0]?.phone_number?.replace(/\D/g, ""), input.miraePhone?.replace(/\D/g, "")].filter(
        (p): p is string => typeof p === "string" && p.length >= 10,
      ),
    ),
  ];
  if (phones.length === 0) return "unknown";
  const day = dayInBrasilia(startAt);
  for (const phone of phones) {
    let answer;
    try {
      answer = await ports.list(config, { phone, from: day, to: day });
    } catch {
      // Mirae down, timeout, two registrations on the phone: the caller decides (retry, draft).
      return "unavailable";
    }
    if (answer.person === null) continue;
    return appointmentStillScheduled(answer.data, input.appointmentStartAt) ? "confirmed" : "gone";
  }
  return "unknown";
}
