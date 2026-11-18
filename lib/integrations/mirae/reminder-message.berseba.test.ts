// @vitest-environment node
/**
 * Berseba: the rule of `POST /api/v1/mirae/reminder-messages` (berseba-crm#127), over an
 * in-memory database that keeps each organization apart, plus the Postgres adapter's SQL.
 */
import { describe, expect, it, vi } from "vitest";

import { followupTurnPayloadSchema } from "@/lib/agent-engine/agent/followup-turn";
import { lembreteDoMirae } from "@/lib/agent-engine/agent/mirae-reminder-turn.berseba";

import {
  deliveryFor,
  miraeReminderMessageSchema,
  queueMiraeReminderMessage,
  reminderDbPg,
  reminderDeliveryOf,
  reminderKindOf,
  type ReminderDb,
  type ReminderDbTx,
} from "./reminder-message";

const ORG_A = "0cc6e9e0-a9b0-42a4-951b-a0cb1e554a48";
const ORG_B = "9d2f5a1e-1111-4c2b-8a77-5b0b7b0b0b0b";
const NOW = new Date("2026-11-17T12:00:00.000Z");

interface Contact {
  org: string;
  id: string;
  phone_number: string;
  is_blocked?: boolean;
}
interface Conversation {
  org: string;
  id: string;
  contactId: string;
  channelSessionId: string;
}
interface Job {
  org: string;
  id: string;
  contactId: string;
  enabled: boolean;
  runAt: Date;
  payload: Record<string, unknown>;
}

function fakeDb(seed: {
  settings?: Record<string, unknown>;
  contacts?: Contact[];
  conversations?: Conversation[];
  jobs?: Job[];
  humans?: string[];
  /** `job_queue` followup turns pending or running (e.g. deferred to the send window). */
  queued?: Array<{ org: string; contactId: string }>;
}) {
  const jobs: Job[] = [...(seed.jobs ?? [])];
  const humanChecks: string[] = [];
  const locks: string[] = [];
  const queued: Array<{ org: string; contactId: string }> = [...(seed.queued ?? [])];
  let n = 0;
  const tx: ReminderDbTx = {
    readSettings: async (org) => seed.settings?.[org] ?? null,
    findByKey: async (org, key) => {
      const j = jobs.find(
        (x) =>
          x.org === org &&
          x.payload.source === "mirae_reminder" &&
          (x.payload.mirae_reminder as { delivery_key: string }).delivery_key === key,
      );
      if (!j) return null;
      const r = j.payload.mirae_reminder as { delivery: "draft" | "auto" };
      return {
        cronJobId: j.id,
        delivery: r.delivery,
        conversationId: j.payload.conversation_id as string,
      };
    },
    findContacts: async (org, phones) =>
      (seed.contacts ?? [])
        .filter((c) => c.org === org && phones.includes(c.phone_number))
        .map((c) => ({ id: c.id, phone_number: c.phone_number, is_blocked: c.is_blocked ?? false })),
    findConversation: async (org, contactId) => {
      const c = (seed.conversations ?? []).find((x) => x.org === org && x.contactId === contactId);
      return c ? { id: c.id, channelSessionId: c.channelSessionId } : null;
    },
    lockContact: async (org, contactId) => {
      locks.push(`${org}:${contactId}`);
    },
    hasLiveReturn: async (org, contactId) =>
      jobs.some((j) => j.org === org && j.contactId === contactId && j.enabled) ||
      queued.some((q) => q.org === org && q.contactId === contactId),
    humanInCharge: async (_org, contactId) => {
      humanChecks.push(contactId);
      return (seed.humans ?? []).includes(contactId);
    },
    beginService: async (org, contactId) => {
      const c = (seed.conversations ?? []).find((x) => x.org === org && x.contactId === contactId)!;
      return {
        organization_id: org,
        contact_id: contactId,
        conversation_id: c.id,
        service_revision: 3,
        demanda_id: null,
        demanda_revision: null,
      };
    },
    insertTurn: async (org, input) => {
      const id = `job-${++n}`;
      jobs.push({ org, id, contactId: input.contactId, enabled: true, runAt: input.runAt, payload: input.payload });
      return id;
    },
  };
  const db: ReminderDb = { withKeyLock: (_org, _key, fn) => fn(tx) };
  return { db, jobs, humanChecks, locks };
}

const STUDENT: Contact = { org: ORG_A, id: "contact-a", phone_number: "+5514996598955" };
const CONVERSATION: Conversation = {
  org: ORG_A,
  id: "conv-a",
  contactId: "contact-a",
  channelSessionId: "channel-a",
};

const BODY = miraeReminderMessageSchema.parse({
  reminder_id: "rem-1",
  delivery_key: "rem-1:2026-11-18T12:00:00.000Z",
  phone: "(14) 99659-8955",
  studentName: "Ana",
  title: "Confirmar avaliação de amanhã",
  note: "Trazer roupa confortável",
  as_of: "2026-11-17T11:59:00.000Z",
  kind: "evaluation_confirmation",
  appointment_start_at: "2026-11-18T12:00:00.000Z",
  professional_first_name: "Raquel",
});

function run(db: ReminderDb, body = BODY, org = ORG_A) {
  return queueMiraeReminderMessage(db, { organizationId: org, now: NOW }, body);
}

describe("pure pieces", () => {
  it("the setting defaults to draft and ignores anything unknown", () => {
    expect(reminderDeliveryOf(null)).toBe("draft");
    expect(reminderDeliveryOf({})).toBe("draft");
    expect(reminderDeliveryOf({ mirae_reminder_delivery: "AUTO" })).toBe("draft");
    expect(reminderDeliveryOf({ mirae_reminder_delivery: "auto" })).toBe("auto");
    expect(reminderDeliveryOf({ mirae_reminder_delivery: "off" })).toBe("off");
  });

  it("an unknown or missing kind is manual", () => {
    expect(reminderKindOf(undefined)).toBe("manual");
    expect(reminderKindOf("birthday")).toBe("manual");
    expect(reminderKindOf("first_class_confirmation")).toBe("first_class_confirmation");
  });

  it("only a confirmation with a time, with the setting on auto and nobody handling the person, is automatic", () => {
    expect(deliveryFor("auto", "evaluation_confirmation", false, true)).toBe("auto");
    expect(deliveryFor("auto", "first_class_confirmation", false, true)).toBe("auto");
    expect(deliveryFor("auto", "manual", false, true)).toBe("draft");
    expect(deliveryFor("auto", "evaluation_confirmation", true, true)).toBe("draft");
    expect(deliveryFor("auto", "evaluation_confirmation", false, false)).toBe("draft");
    expect(deliveryFor("draft", "evaluation_confirmation", false, true)).toBe("draft");
  });

  it("the body accepts what Mirae sends today, and extra fields", () => {
    const today = {
      reminder_id: "r",
      delivery_key: "r:2026-11-18T12:00:00.000Z",
      phone: "14 99659-8955",
      studentName: "Ana",
      title: "Mandar o contrato",
      note: null,
      as_of: "2026-11-17T11:00:00.000Z",
      something_new: { x: 1 },
    };
    expect(miraeReminderMessageSchema.safeParse(today).success).toBe(true);
    expect(miraeReminderMessageSchema.safeParse({ ...today, title: "" }).success).toBe(false);
    expect(miraeReminderMessageSchema.safeParse({ ...today, phone: "1" }).success).toBe(false);
    expect(
      miraeReminderMessageSchema.safeParse({ ...today, appointment_start_at: "amanhã" }).success,
    ).toBe(false);
  });
});

describe("queueMiraeReminderMessage", () => {
  it("draft (the default): queues one followup turn due now, with the briefing", async () => {
    const { db, jobs } = fakeDb({ contacts: [STUDENT], conversations: [CONVERSATION] });
    const result = await run(db);
    expect(result).toEqual({
      outcome: "drafted",
      delivery: "draft",
      cronJobId: "job-1",
      conversationId: "conv-a",
    });
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job).toMatchObject({ org: ORG_A, contactId: "contact-a", runAt: NOW });
    expect(job.payload).toMatchObject({
      source: "mirae_reminder",
      promised_at: NOW.toISOString(),
      conversation_id: "conv-a",
      service_boundary: { conversation_id: "conv-a", service_revision: 3 },
    });
    // No `purpose`: the turn path treats it as a return that talks to the person (send window).
    expect(job.payload).not.toHaveProperty("purpose");
    // The worker's payload schema accepts it (a `promise: null` made every job die at parse).
    expect(job.payload).not.toHaveProperty("promise");
    expect(followupTurnPayloadSchema.safeParse(job.payload).success).toBe(true);
    expect(job.payload).not.toHaveProperty("followup_enrollment_id");
    // The worker reads back exactly what the endpoint wrote.
    expect(lembreteDoMirae(job.payload)).toEqual({
      delivery_key: "rem-1:2026-11-18T12:00:00.000Z",
      reminder_id: "rem-1",
      delivery: "draft",
      kind: "evaluation_confirmation",
      title: "Confirmar avaliação de amanhã",
      note: "Trazer roupa confortável",
      student_name: "Ana",
      appointment_start_at: "2026-11-18T12:00:00.000Z",
      professional_first_name: "Raquel",
      mirae_phone: "14996598955",
    });
  });

  it("auto: a confirmation is scheduled for the agent to send", async () => {
    const { db, jobs } = fakeDb({
      settings: { [ORG_A]: { mirae_reminder_delivery: "auto" } },
      contacts: [STUDENT],
      conversations: [CONVERSATION],
    });
    expect(await run(db)).toMatchObject({ outcome: "scheduled", delivery: "auto", cronJobId: "job-1" });
    expect(jobs).toHaveLength(1);
    expect(lembreteDoMirae(jobs[0]!.payload)?.delivery).toBe("auto");
  });

  it.each([
    ["first_class_confirmation", "scheduled"],
    ["manual", "drafted"],
    [undefined, "drafted"],
    ["something_mirae_adds_later", "drafted"],
  ])("auto with kind %s → %s", async (kind, outcome) => {
    const { db } = fakeDb({
      settings: { [ORG_A]: { mirae_reminder_delivery: "auto" } },
      contacts: [STUDENT],
      conversations: [CONVERSATION],
    });
    expect((await run(db, { ...BODY, kind })).outcome).toBe(outcome);
  });

  it("auto: a confirmation without appointment_start_at is a draft (nothing to check in Mirae)", async () => {
    const { db, humanChecks } = fakeDb({
      settings: { [ORG_A]: { mirae_reminder_delivery: "auto" } },
      contacts: [STUDENT],
      conversations: [CONVERSATION],
    });
    expect((await run(db, { ...BODY, appointment_start_at: undefined })).outcome).toBe("drafted");
    expect(humanChecks).toEqual([]);
  });

  it("auto: a person handling the contact (force_human, always human…) gets a draft instead", async () => {
    const { db, jobs, humanChecks } = fakeDb({
      settings: { [ORG_A]: { mirae_reminder_delivery: "auto" } },
      contacts: [STUDENT],
      conversations: [CONVERSATION],
      humans: ["contact-a"],
    });
    expect(await run(db)).toMatchObject({ outcome: "drafted", delivery: "draft" });
    expect(humanChecks).toEqual(["contact-a"]);
    expect(lembreteDoMirae(jobs[0]!.payload)?.delivery).toBe("draft");
  });

  it("draft mode never asks who handles the contact", async () => {
    const { db, humanChecks } = fakeDb({ contacts: [STUDENT], conversations: [CONVERSATION] });
    await run(db);
    expect(humanChecks).toEqual([]);
  });

  it("off: refused, nothing read nor created", async () => {
    const { db, jobs } = fakeDb({
      settings: { [ORG_A]: { mirae_reminder_delivery: "off" } },
      contacts: [STUDENT],
      conversations: [CONVERSATION],
    });
    expect(await run(db)).toEqual({ outcome: "disabled" });
    expect(jobs).toEqual([]);
  });

  describe("idempotency", () => {
    it("the same delivery key twice: already_drafted, one job", async () => {
      const { db, jobs } = fakeDb({ contacts: [STUDENT], conversations: [CONVERSATION] });
      await run(db);
      expect(await run(db)).toEqual({
        outcome: "already_drafted",
        delivery: "draft",
        cronJobId: "job-1",
        conversationId: "conv-a",
      });
      expect(jobs).toHaveLength(1);
    });

    it("auto: the same key twice answers scheduled again (replayed), one job, ever", async () => {
      const { db, jobs } = fakeDb({
        settings: { [ORG_A]: { mirae_reminder_delivery: "auto" } },
        contacts: [STUDENT],
        conversations: [CONVERSATION],
      });
      await run(db);
      jobs[0]!.enabled = false; // the one-shot fired
      expect(await run(db)).toEqual({
        outcome: "scheduled",
        replayed: true,
        delivery: "auto",
        cronJobId: "job-1",
        conversationId: "conv-a",
      });
      expect(jobs).toHaveLength(1);
    });

    it("the replay answers before the contact checks (a contact blocked later still replays)", async () => {
      const { db } = fakeDb({ contacts: [STUDENT], conversations: [CONVERSATION] });
      await run(db);
      STUDENT.is_blocked = true;
      try {
        expect((await run(db)).outcome).toBe("already_drafted");
      } finally {
        STUDENT.is_blocked = false;
      }
    });

    it("without delivery_key the key is the reminder_id", async () => {
      const { db, jobs } = fakeDb({ contacts: [STUDENT], conversations: [CONVERSATION] });
      const body = { ...BODY, delivery_key: undefined };
      await run(db, body);
      expect(lembreteDoMirae(jobs[0]!.payload)?.delivery_key).toBe("rem-1");
      expect((await run(db, body)).outcome).toBe("already_drafted");
    });
  });

  describe("the contact, by phone", () => {
    it.each([
      ["stored with the 9th digit, sent without it", "+5514996598955", "(14) 9659-8955"],
      ["stored without the 9th digit, sent with it", "+551496598955", "(14) 99659-8955"],
      ["sent with 55 and no mask", "+5514996598955", "5514996598955"],
    ])("%s", async (_label, stored, sent) => {
      const { db } = fakeDb({
        contacts: [{ ...STUDENT, phone_number: stored }],
        conversations: [CONVERSATION],
      });
      expect((await run(db, { ...BODY, phone: sent })).outcome).toBe("drafted");
    });

    it("no contact with the phone: contact_not_found, nothing created", async () => {
      const { db, jobs } = fakeDb({ contacts: [], conversations: [] });
      expect(await run(db)).toEqual({ outcome: "contact_not_found" });
      expect(jobs).toEqual([]);
    });

    it("a phone that is not a phone: contact_not_found", async () => {
      const { db } = fakeDb({ contacts: [STUDENT], conversations: [CONVERSATION] });
      expect((await run(db, { ...BODY, phone: "abcdefghij" })).outcome).toBe("contact_not_found");
    });

    it("a contact with no WhatsApp conversation: contact_not_found, nothing created", async () => {
      const { db, jobs } = fakeDb({ contacts: [STUDENT], conversations: [] });
      expect((await run(db)).outcome).toBe("contact_not_found");
      expect(jobs).toEqual([]);
    });

    it("a blocked contact (opt-out) never gets a draft nor a send", async () => {
      for (const delivery of ["draft", "auto"]) {
        const { db, jobs } = fakeDb({
          settings: { [ORG_A]: { mirae_reminder_delivery: delivery } },
          contacts: [{ ...STUDENT, is_blocked: true }],
          conversations: [CONVERSATION],
        });
        expect(await run(db)).toEqual({ outcome: "contact_blocked", conversationId: "conv-a" });
        expect(jobs).toEqual([]);
      }
    });
  });

  it("a live scheduled return of the agent: already_handled, nothing created", async () => {
    const live: Job = {
      org: ORG_A,
      id: "agent-return",
      contactId: "contact-a",
      enabled: true,
      runAt: NOW,
      payload: { reason: "reconfirmar", promise: "volto amanhã" },
    };
    for (const delivery of ["draft", "auto"]) {
      const { db, jobs } = fakeDb({
        settings: { [ORG_A]: { mirae_reminder_delivery: delivery } },
        contacts: [STUDENT],
        conversations: [CONVERSATION],
        jobs: [live],
      });
      expect(await run(db)).toEqual({ outcome: "already_handled", conversationId: "conv-a" });
      expect(jobs).toEqual([live]);
    }
  });

  it("a return turn already queued or running (deferred to the window): already_handled", async () => {
    const { db, jobs, locks } = fakeDb({
      contacts: [STUDENT],
      conversations: [CONVERSATION],
      queued: [{ org: ORG_A, contactId: "contact-a" }],
    });
    expect(await run(db)).toEqual({ outcome: "already_handled", conversationId: "conv-a" });
    expect(jobs).toEqual([]);
    expect(locks).toEqual([`${ORG_A}:contact-a`]);
  });

  it("two reminders with different keys for one person: the second is already_handled", async () => {
    const { db, jobs, locks } = fakeDb({ contacts: [STUDENT], conversations: [CONVERSATION] });
    expect((await run(db)).outcome).toBe("drafted");
    expect((await run(db, { ...BODY, delivery_key: "rem-2:x", reminder_id: "rem-2" })).outcome).toBe(
      "already_handled",
    );
    expect(jobs).toHaveLength(1);
    // Both took the contact lock before looking for a live return.
    expect(locks).toEqual([`${ORG_A}:contact-a`, `${ORG_A}:contact-a`]);
  });

  it("a return that already fired does not count as live", async () => {
    const fired: Job = {
      org: ORG_A,
      id: "old",
      contactId: "contact-a",
      enabled: false,
      runAt: NOW,
      payload: { reason: "x" },
    };
    const { db } = fakeDb({ contacts: [STUDENT], conversations: [CONVERSATION], jobs: [fired] });
    expect((await run(db)).outcome).toBe("drafted");
  });

  describe("organization isolation", () => {
    it("a token of one organization never reaches a contact of another", async () => {
      const { db, jobs } = fakeDb({
        contacts: [{ ...STUDENT, org: ORG_B }],
        conversations: [{ ...CONVERSATION, org: ORG_B }],
      });
      expect((await run(db, BODY, ORG_A)).outcome).toBe("contact_not_found");
      expect(jobs).toEqual([]);
    });

    it("the same key in another organization is a different reminder", async () => {
      const { db, jobs } = fakeDb({
        contacts: [STUDENT, { ...STUDENT, org: ORG_B, id: "contact-b" }],
        conversations: [CONVERSATION, { ...CONVERSATION, org: ORG_B, id: "conv-b", contactId: "contact-b" }],
      });
      expect((await run(db, BODY, ORG_A)).outcome).toBe("drafted");
      expect(await run(db, BODY, ORG_B)).toMatchObject({ outcome: "drafted", conversationId: "conv-b" });
      expect(jobs.map((j) => [j.org, j.contactId])).toEqual([
        [ORG_A, "contact-a"],
        [ORG_B, "contact-b"],
      ]);
    });

    it("each organization reads its own setting", async () => {
      const { db } = fakeDb({
        settings: { [ORG_B]: { mirae_reminder_delivery: "auto" } },
        contacts: [STUDENT],
        conversations: [CONVERSATION],
      });
      expect((await run(db, BODY, ORG_A)).outcome).toBe("drafted");
    });
  });
});

describe("reminderDbPg (the SQL)", () => {
  function recordingPool(answers: Record<string, unknown[]> = {}) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        const hit = Object.entries(answers).find(([k]) => sql.includes(k));
        return { rows: hit ? hit[1] : [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    return { pool: pool as never, client, calls };
  }

  it("runs the rule in one transaction holding a lock on (organization, key)", async () => {
    const { pool, calls, client } = recordingPool();
    await reminderDbPg(pool, async () => false).withKeyLock(ORG_A, "k", async () => "x");
    expect(calls.map((c) => c.sql)).toEqual([
      "begin",
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      "commit",
    ]);
    expect(calls[1]!.params).toEqual([`mirae_reminder:${ORG_A}:k`]);
    expect(client.release).toHaveBeenCalled();
  });

  it("rolls back and releases on error", async () => {
    const { pool, calls, client } = recordingPool();
    await expect(
      reminderDbPg(pool, async () => false).withKeyLock(ORG_A, "k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(calls.at(-1)!.sql).toBe("rollback");
    expect(client.release).toHaveBeenCalled();
  });

  it("every query of the rule filters by the token's organization", async () => {
    const { pool, calls } = recordingPool({
      "from contacts": [{ id: "contact-a", phone_number: "+5514996598955", is_blocked: false }],
      "from conversations": [{ id: "conv-a", channel_session_id: "channel-a" }],
      fn_service_begin: [
        {
          b: {
            organization_id: ORG_A,
            contact_id: "contact-a",
            conversation_id: "conv-a",
            service_revision: 2,
            demanda_id: null,
            demanda_revision: null,
            status: "open",
          },
        },
      ],
      "insert into cron_jobs": [{ id: "job-1" }],
    });
    const result = await run(reminderDbPg(pool, async () => false));
    expect(result).toMatchObject({ outcome: "drafted", cronJobId: "job-1" });
    const ruleQueries = calls.filter(
      (c) => !["begin", "commit"].includes(c.sql) && !c.sql.includes("pg_advisory_xact_lock"),
    );
    expect(ruleQueries.length).toBeGreaterThanOrEqual(6);
    for (const q of ruleQueries) expect(q.params[0]).toBe(ORG_A);
    for (const q of ruleQueries.filter(
      (c) => !c.sql.includes("fn_service_begin") && !c.sql.includes("insert into"),
    )) {
      expect(q.sql).toMatch(/organization_id = \$1|where id = \$1/);
    }
    const insert = calls.find((c) => c.sql.includes("insert into cron_jobs"))!;
    expect(insert.sql).toContain("'at', 'followup_turn'");
    // The contact lock comes before the live-return check, which also reads the job queue.
    const iLock = calls.findIndex((c) => c.params[0] === `mirae_reminder_contact:${ORG_A}:contact-a`);
    const iLive = calls.findIndex((c) => c.sql.includes("from job_queue"));
    expect(iLock).toBeGreaterThan(-1);
    expect(iLive).toBeGreaterThan(iLock);
    expect(calls[iLive]!.sql).toContain("status in ('pending', 'running')");
    expect(insert.params[3]).toEqual(NOW);
    // The boundary is stored as its identity, without status/timestamps.
    expect((insert.params[2] as { service_boundary: unknown }).service_boundary).toEqual({
      organization_id: ORG_A,
      contact_id: "contact-a",
      conversation_id: "conv-a",
      service_revision: 2,
      demanda_id: null,
      demanda_revision: null,
    });
  });
});
