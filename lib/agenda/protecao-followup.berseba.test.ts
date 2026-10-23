import { expect, it, vi } from "vitest";
import { AGENDA_CONTACTS_PER_QUERY, protecaoAgendaSupabase } from "@/lib/agenda/protecao-followup";
import { logger } from "@/lib/logger";

const now = new Date("2026-10-23T12:00:00Z");

// Production, 2026-10-23: the Mayara Morales salon reached 400 open leads, the
// `in.(…)` URL passed ~15.8 KB and every read came back "leitura_indisponivel".
function fakeDb(appointments: Array<{ id: string; contact_id: string }>) {
  const batches: string[][] = [];
  const from = (table: string) => {
    let contacts: string[] = [];
    let cursor = "";
    const q = {
      select: () => q,
      eq: () => q,
      in: (column: string, values: string[]) => {
        if (column === "contact_id") contacts = values;
        return q;
      },
      order: () => q,
      limit: () => q,
      gt: (_key: string, value: string) => {
        cursor = value;
        return q;
      },
      single: async () => ({ data: { settings: {} }, error: null }),
      then: (resolve: (value: unknown) => unknown) => {
        if (table === "calendar_appointments" && !cursor) batches.push(contacts);
        const tooLong = contacts.join(",").length > 15_000;
        return Promise.resolve(
          tooLong
            ? { data: null, error: { message: "UND_ERR_HEADERS_OVERFLOW" } }
            : {
                data: appointments
                  .filter((a) => contacts.includes(a.contact_id) && a.id > cursor)
                  .map((a) => ({
                    ...a,
                    revision: 1,
                    status: "confirmed",
                    starts_at: "2026-10-24T12:00:00Z",
                    ends_at: "2026-10-24T13:00:00Z",
                  })),
                error: null,
              },
        ).then(resolve);
      },
    };
    return q;
  };
  return { db: { from } as never, batches };
}

it("400 contacts are read in batches, and an appointment of the last batch still protects", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const contacts = Array.from(
    { length: 400 },
    (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  );
  const { db, batches } = fakeDb([{ id: "a1", contact_id: contacts[399]! }]);

  const result = await protecaoAgendaSupabase(db, "org", contacts, now);

  expect(batches).toHaveLength(400 / AGENDA_CONTACTS_PER_QUERY);
  expect(batches.every((b) => b.length <= AGENDA_CONTACTS_PER_QUERY)).toBe(true);
  expect(batches.flat()).toEqual(contacts);
  expect(result.get(contacts[399]!)).toMatchObject({
    adiar: true,
    motivo: "agendado",
    appointment_id: "a1",
  });
  expect(result.get(contacts[0]!)).toMatchObject({ adiar: false, motivo: "sem_compromisso" });
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
});

it("a failed batch still makes the whole read unavailable, never a partial absence", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const contacts = Array.from({ length: 150 }, (_, n) => `c${n}`);
  let batch = 0;
  const q = {
    select: () => q,
    eq: () => q,
    in: (column: string) => {
      if (column === "contact_id") batch += 1;
      return q;
    },
    order: () => q,
    limit: () => q,
    gt: () => q,
    single: async () => ({ data: { settings: {} }, error: null }),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(
        batch === 2 ? { data: null, error: { message: "boom" } } : { data: [], error: null },
      ).then(resolve),
  };

  const result = await protecaoAgendaSupabase({ from: () => q } as never, "org", contacts, now);

  expect(batch).toBe(2);
  expect([...result.values()].every((p) => p.motivo === "leitura_indisponivel")).toBe(true);
  warn.mockRestore();
});
