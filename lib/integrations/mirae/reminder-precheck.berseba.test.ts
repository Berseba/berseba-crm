// @vitest-environment node
/**
 * Berseba: the Mirae check right before a confirmation reminder runs. Mirae cannot recall a
 * reminder, so an appointment cancelled or moved since it asked must get nothing.
 */
import { describe, expect, it, vi } from "vitest";

import type { MiraeConfig } from "./config";
import {
  appointmentStillScheduled,
  checkMiraeAppointment,
  dayInBrasilia,
} from "./reminder-precheck";

const CONFIG: MiraeConfig = { orgUrl: "https://mirae.example/api/v1/orgs/fiore", apiKey: "k", orgIds: new Set(["org"]) };
const START = "2026-11-18T12:00:00.000Z";
const appt = (over: Record<string, unknown> = {}) => ({
  id: "apt-1",
  service: "evaluation",
  starts_at: "2026-11-18T09:00:00-03:00",
  ends_at: "2026-11-18T10:00:00-03:00",
  date: "2026-11-18",
  time: "09:00",
  weekday: "quarta-feira",
  professional: { id: "p", first_name: "Raquel" },
  status: "scheduled",
  can_change: true,
  ...over,
});

function pool(phone: string | null = "+55 (14) 99659-8955") {
  const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [{ phone_number: phone }] }));
  return { query } as never as { query: typeof query };
}

describe("pure pieces", () => {
  it("the agenda day is Brasília's", () => {
    expect(dayInBrasilia(new Date("2026-11-19T01:30:00.000Z"))).toBe("2026-11-18");
    expect(dayInBrasilia(new Date(START))).toBe("2026-11-18");
  });

  it("matches the same instant whatever the offset, and only a scheduled one", () => {
    expect(appointmentStillScheduled([appt()], START)).toBe(true);
    expect(appointmentStillScheduled([appt({ status: "cancelled" })], START)).toBe(false);
    expect(appointmentStillScheduled([appt({ status: "no_show" })], START)).toBe(false);
    expect(appointmentStillScheduled([appt({ starts_at: "2026-11-18T10:00:00-03:00" })], START)).toBe(false);
    expect(appointmentStillScheduled([], START)).toBe(false);
  });
});

describe("checkMiraeAppointment", () => {
  const input = { organizationId: "org", contactId: "contact", appointmentStartAt: START };

  it("still scheduled at that time → confirmed; reads the contact's phone of this organization, that day", async () => {
    const db = pool();
    const list = vi.fn(async () => ({ person: null, data: [appt()] }));
    expect(await checkMiraeAppointment(db as never, input, { configFor: () => CONFIG, list })).toBe("confirmed");
    expect(db.query.mock.calls[0]).toEqual([
      "select phone_number from contacts where organization_id = $1 and id = $2",
      ["org", "contact"],
    ]);
    expect(list).toHaveBeenCalledWith(CONFIG, { phone: "5514996598955", from: "2026-11-18", to: "2026-11-18" });
  });

  it.each([
    ["cancelled", [appt({ status: "cancelled" })]],
    ["moved to another time", [appt({ starts_at: "2026-11-18T15:00:00-03:00" })]],
    ["gone", []],
  ])("%s → gone", async (_label, data) => {
    const list = vi.fn(async () => ({ person: null, data }));
    expect(await checkMiraeAppointment(pool() as never, input, { configFor: () => CONFIG, list })).toBe("gone");
  });

  it("no Mirae for this organization, no phone, a bad time or Mirae not answering → unknown", async () => {
    const list = vi.fn(async () => ({ person: null, data: [appt()] }));
    expect(await checkMiraeAppointment(pool() as never, input, { configFor: () => null, list })).toBe("unknown");
    expect(await checkMiraeAppointment(pool(null) as never, input, { configFor: () => CONFIG, list })).toBe("unknown");
    expect(
      await checkMiraeAppointment(pool() as never, { ...input, appointmentStartAt: "x" }, { configFor: () => CONFIG, list }),
    ).toBe("unknown");
    expect(list).not.toHaveBeenCalled();
    const down = vi.fn(async () => {
      throw new Error("timeout");
    });
    expect(await checkMiraeAppointment(pool() as never, input, { configFor: () => CONFIG, list: down })).toBe("unknown");
  });
});
