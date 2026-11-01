/** S5 consumer: remap on editable receipts, audit-only rejection, org check, applied ledger, catch-up. */
import { beforeEach, expect, it, vi } from "vitest";
import { fixturesForSeam } from "@checkin/receipt-contract-fixtures";
import { db } from "../../db";
import type { OrgEventRecord } from "../../contract";
import { catchUpOrgEvents, orgEventConsumer } from "../../services/orgEventConsumer";
import { describeDb } from "../helpers/db";
import { OTHER_ORG_ID, TEST_ORG_ID, clearAll, configure, makeLineStatus, makeReceipt } from "../helpers/setup";

const PROV = "2000000000015";
const REAL = "0000000000017";

function event(id: number, eventType: string, body: Record<string, unknown>, orgId = TEST_ORG_ID): OrgEventRecord {
  return { id, orgId, eventType, payload: JSON.stringify({ version: 1, ...body }) };
}
const approved = (id: number, orgId?: string) =>
  event(id, "provisional_approved", { provisionalGtin13: PROV, realGtin13: REAL, name: "Widget", conversionFactor: 6, conversionVersion: 2 }, orgId);

async function provisionalLine(state: "pending_review" | "applying" | "apply_failed" | "resolved") {
  const r = await makeReceipt({ state });
  return makeLineStatus(r.id, { recognitionStatus: "provisional", provisionalItemGtin13: PROV });
}

async function applied(): Promise<number[]> {
  return (await db.workflowAppliedOrgEvent.findMany({ orderBy: { id: "asc" } })).map((r) => r.id);
}

const rejected = (id: number) => event(id, "provisional_rejected", { provisionalGtin13: "2000000000022", rejectionReason: "dup" });
const malformed = (id: number) => event(id, "provisional_approved", { bad: true });

/** A source that honours the id cursor and returns at most `pageSize` events, like the catalog. */
const paged = (events: OrgEventRecord[], pageSize = 500) => ({
  eventsSince: async (_org: string, after: number) => events.filter((e) => e.id > after).slice(0, pageSize),
});

const CLEAN = { applied: 0, failed: 0, unprocessed: 0, unreadable: false };

beforeEach(async () => {
  await clearAll();
  configure();
});

describeDb("S5 remap", () => {
  it("remaps lines on pending_review receipts only", async () => {
    const pending = await provisionalLine("pending_review");
    const failed = await provisionalLine("apply_failed");
    const applying = await provisionalLine("applying");
    const resolved = await provisionalLine("resolved");

    await orgEventConsumer.onOrgEvents([approved(5)]);

    for (const ls of [pending]) {
      expect(await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).toMatchObject({
        recognitionStatus: "recognized",
        assignedGtin13: REAL,
        conversionFactor: 6,
        conversionVersion: 2,
      });
    }
    for (const ls of [failed, applying, resolved]) {
      expect(await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).toMatchObject({
        recognitionStatus: "provisional",
        assignedGtin13: null,
      });
    }
    expect(await db.workflowAuditLog.count({ where: { eventType: "line_remapped" } })).toBe(1);
    expect(await applied()).toEqual([5]);
  });

  it("leaves a recognized line that still carries the provisional GTIN alone", async () => {
    const r = await makeReceipt({ state: "pending_review" });
    const ls = await makeLineStatus(r.id, {
      recognitionStatus: "recognized",
      assignedGtin13: "0000000000024",
      provisionalItemGtin13: PROV,
    });
    await orgEventConsumer.onOrgEvents([approved(5)]);
    expect(await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).toMatchObject({
      recognitionStatus: "recognized",
      assignedGtin13: "0000000000024",
    });
    expect(await db.workflowAuditLog.count({ where: { eventType: "line_remapped" } })).toBe(0);
  });

  it("provisional_mapped_to_existing remaps the same way", async () => {
    const ls = await provisionalLine("pending_review");
    await orgEventConsumer.onOrgEvents([
      event(3, "provisional_mapped_to_existing", { provisionalGtin13: PROV, realGtin13: REAL }),
    ]);
    expect((await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).assignedGtin13).toBe(REAL);
  });

  it("provisional_rejected is audit-only", async () => {
    const ls = await provisionalLine("pending_review");
    await orgEventConsumer.onOrgEvents([event(4, "provisional_rejected", { provisionalGtin13: PROV, rejectionReason: "dup" })]);
    expect((await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).recognitionStatus).toBe("provisional");
    expect(await db.workflowAuditLog.count({ where: { eventType: "provisional_rejected" } })).toBe(1);
  });

  it("every shared S5 fixture is consumed without error", async () => {
    const fixtures = fixturesForSeam<{ eventType: string } & Record<string, unknown>>("S5-org-events");
    const events = fixtures.map(({ value }, i) => {
      const { eventType, ...rest } = value;
      return { id: i + 1, orgId: TEST_ORG_ID, eventType, payload: JSON.stringify(rest) };
    });
    await orgEventConsumer.onOrgEvents(events);
    expect(await applied()).toHaveLength(events.length);
  });

  it("replay is a no-op: a re-applied event changes nothing and audits nothing new", async () => {
    await provisionalLine("pending_review");
    const rejected = event(6, "provisional_rejected", { provisionalGtin13: "2000000000022", rejectionReason: "dup" });
    await orgEventConsumer.onOrgEvents([approved(5), rejected]);
    await orgEventConsumer.onOrgEvents([approved(5), rejected]);
    expect(await db.workflowAuditLog.count({ where: { eventType: "line_remapped" } })).toBe(1);
    expect(await db.workflowAuditLog.count({ where: { eventType: "provisional_rejected" } })).toBe(1);
  });

  it("an event committed after a higher id is still applied", async () => {
    const ls = await provisionalLine("pending_review");
    await orgEventConsumer.onOrgEvents([event(8, "provisional_rejected", { provisionalGtin13: "2000000000022", rejectionReason: "dup" })]);
    await orgEventConsumer.onOrgEvents([approved(7)]);
    expect((await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).assignedGtin13).toBe(REAL);
    expect(await applied()).toEqual([7, 8]);
  });

  it("an event for another org is rejected, audited, and later events still apply", async () => {
    const ls = await provisionalLine("pending_review");
    await orgEventConsumer.onOrgEvents([approved(1, OTHER_ORG_ID), approved(2)]);
    expect(await applied()).toEqual([1, 2]);
    expect((await db.workflowAuditLog.findFirstOrThrow({ where: { eventType: "org_event_rejected" } })).details).toMatch(/"eventId":1/);
    expect((await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).assignedGtin13).toBe(REAL);
  });
});

describeDb("catch-up sweep", () => {
  it("is a no-op with the inert event source", async () => {
    expect(await catchUpOrgEvents()).toEqual(CLEAN);
  });

  it("replays past a bad event, records it, and retries it by id", async () => {
    const asked: number[] = [];
    const poison = event(3, "provisional_approved", { bad: true });
    configure({
      catalogEventSource: {
        eventsSince: async (_org, since) => {
          asked.push(since);
          return [approved(1), approved(2), poison, approved(4)].filter((e) => e.id > since);
        },
      },
    });
    expect(await catchUpOrgEvents()).toEqual({ ...CLEAN, applied: 3, failed: 1 });
    expect(await applied()).toEqual([1, 2, 4]);
    expect(await db.workflowFailedOrgEvent.findMany()).toMatchObject([{ id: 3, eventType: "provisional_approved" }]);

    // The recorded failure is retried by id from its stored payload, and applied events are not applied again.
    expect(await catchUpOrgEvents()).toEqual({ ...CLEAN, failed: 1 });
    expect(asked).toEqual([0, 4, 0, 4]);
  });

  it("a bad event in the post-commit call-out does not block later events, and a fixed retry clears it", async () => {
    const ls = await provisionalLine("pending_review");
    await orgEventConsumer.onOrgEvents([event(3, "provisional_approved", { bad: true }), approved(4)]);

    expect((await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).assignedGtin13).toBe(REAL);
    expect(await applied()).toEqual([4]);
    expect(await db.workflowFailedOrgEvent.count()).toBe(1);

    // A failure that clears (the stored payload now applies) is removed from the record.
    await db.workflowFailedOrgEvent.update({ where: { id: 3 }, data: { payload: approved(3).payload } });
    expect(await catchUpOrgEvents()).toEqual({ ...CLEAN, applied: 1 });
    expect(await db.workflowFailedOrgEvent.count()).toBe(0);
  });

  it("catch-up consumes an event that committed after a higher id was applied", async () => {
    const ls = await provisionalLine("pending_review");
    // Event 8 committed and was applied first; event 7 committed after it.
    await orgEventConsumer.onOrgEvents([event(8, "provisional_rejected", { provisionalGtin13: "2000000000022", rejectionReason: "dup" })]);
    configure({ catalogEventSource: { eventsSince: async (_org, since) => [approved(7), event(8, "provisional_rejected", { provisionalGtin13: "2000000000022", rejectionReason: "dup" })].filter((e) => e.id > since) } });

    expect(await catchUpOrgEvents()).toEqual({ ...CLEAN, applied: 1 });

    expect((await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).assignedGtin13).toBe(REAL);
    expect(await db.workflowAuditLog.count({ where: { eventType: "provisional_rejected" } })).toBe(1);
    expect(await applied()).toEqual([7, 8]);
  });

  it("applies an event lost more than 100 ids behind the newest", async () => {
    const ls = await provisionalLine("pending_review");
    const later = Array.from({ length: 150 }, (_, i) => rejected(i + 8));
    await orgEventConsumer.onOrgEvents(later);
    configure({ catalogEventSource: paged([approved(7), ...later]) });

    expect(await catchUpOrgEvents()).toEqual({ ...CLEAN, applied: 1 });

    expect((await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).assignedGtin13).toBe(REAL);
  });

  it("reads every page of the catalog, however long its history", async () => {
    const events = Array.from({ length: 5 }, (_, i) => rejected(i + 1));
    configure({ catalogEventSource: paged(events, 2) });
    expect(await catchUpOrgEvents()).toEqual({ ...CLEAN, applied: 5 });
    expect(await applied()).toEqual([1, 2, 3, 4, 5]);
  });

  it("a capped run drains over later runs without alerting", async () => {
    const orgEventsStuck = vi.fn(async () => {});
    configure({ catalogEventSource: paged([rejected(1), rejected(2), rejected(3)]), alerts: { orgEventsStuck } });

    expect(await catchUpOrgEvents({ limit: 2 })).toEqual({ ...CLEAN, applied: 2, unprocessed: 1 });
    expect(await catchUpOrgEvents({ limit: 2 })).toEqual({ ...CLEAN, applied: 1 });
    expect(orgEventsStuck).not.toHaveBeenCalled();
  });

  it("failures that keep failing leave room in the cap for new events", async () => {
    await orgEventConsumer.onOrgEvents([malformed(1), malformed(2), malformed(3), malformed(4)]);
    configure({ catalogEventSource: paged([malformed(1), malformed(2), malformed(3), malformed(4), rejected(5)]) });

    expect(await catchUpOrgEvents({ limit: 4 })).toEqual({ ...CLEAN, applied: 1, failed: 3, unprocessed: 1 });
    expect(await applied()).toEqual([5]);
  });
});

describeDb("catch-up alerts", () => {
  it("alerts on each run while the catalog can't be read, and still retries failures", async () => {
    const orgEventsStuck = vi.fn(async () => {});
    await orgEventConsumer.onOrgEvents([malformed(1)]);
    configure({ catalogEventSource: { eventsSince: async () => { throw new Error("catalog down"); } }, alerts: { orgEventsStuck } });

    expect(await catchUpOrgEvents()).toEqual({ ...CLEAN, failed: 1, unreadable: true });
    await catchUpOrgEvents();
    expect(orgEventsStuck).toHaveBeenCalledTimes(2);
    expect(orgEventsStuck).toHaveBeenCalledWith({ failed: 0, unprocessed: 0, unreadable: true });
  });

  it("alerts when an event first fails in the sweep, not on later retries", async () => {
    const orgEventsStuck = vi.fn(async () => {});
    configure({ catalogEventSource: paged([malformed(1)]), alerts: { orgEventsStuck } });

    await catchUpOrgEvents();
    await catchUpOrgEvents();
    expect(orgEventsStuck).toHaveBeenCalledTimes(1);
    expect(orgEventsStuck).toHaveBeenCalledWith({ failed: 1, unprocessed: 0, unreadable: false });
  });

  it("alerts when an event first fails in the call-out, not when the sweep retries it", async () => {
    const orgEventsStuck = vi.fn(async () => {});
    configure({ catalogEventSource: paged([malformed(1)]), alerts: { orgEventsStuck } });

    await orgEventConsumer.onOrgEvents([malformed(1)]);
    await catchUpOrgEvents();
    expect(orgEventsStuck).toHaveBeenCalledTimes(1);
  });

  it("alerts on each run while a capped run applies nothing", async () => {
    const orgEventsStuck = vi.fn(async () => {});
    configure({ catalogEventSource: paged([rejected(1)]), alerts: { orgEventsStuck } });

    await catchUpOrgEvents({ limit: 0 });
    await catchUpOrgEvents({ limit: 0 });
    expect(orgEventsStuck).toHaveBeenCalledTimes(2);
  });

  it("finishes the run when the alert itself throws", async () => {
    configure({ catalogEventSource: paged([malformed(1)]), alerts: { orgEventsStuck: async () => { throw new Error("mail down"); } } });
    expect(await catchUpOrgEvents()).toEqual({ ...CLEAN, failed: 1 });
  });

  it("finishes the sweep when a ledger write throws", async () => {
    const spy = vi.spyOn(db.workflowAppliedOrgEvent, "createMany").mockRejectedValueOnce(new Error("db blip"));
    configure({ catalogEventSource: paged([rejected(1), rejected(2)]) });
    try {
      expect(await catchUpOrgEvents()).toMatchObject({ applied: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(await applied()).toEqual([2]);
  });
});

describeDb("first-run replay", () => {
  it("replaying all history over current state changes nothing", async () => {
    const remapped = await provisionalLine("pending_review");
    const managerLinked = await makeLineStatus((await makeReceipt({ state: "pending_review" })).id, {
      recognitionStatus: "provisional",
      provisionalItemGtin13: PROV,
    });
    const leftReview = await provisionalLine("resolved");
    const history = [
      approved(1),
      event(2, "provisional_mapped_to_existing", { provisionalGtin13: "2000000000039", realGtin13: REAL }),
      rejected(3),
      approved(4, OTHER_ORG_ID),
    ];
    await db.receivedReceiptLineStatus.update({
      where: { id: managerLinked.id },
      data: { recognitionStatus: "non_inventory", provisionalItemGtin13: null },
    });
    await orgEventConsumer.onOrgEvents(history);
    const snapshot = async () => ({
      lines: await db.receivedReceiptLineStatus.findMany({ orderBy: { id: "asc" } }),
      audit: await db.workflowAuditLog.findMany({ orderBy: { id: "asc" } }),
    });
    const before = await snapshot();
    expect(before.lines.map((l) => l.id)).toEqual(expect.arrayContaining([remapped.id, leftReview.id]));

    await db.workflowAppliedOrgEvent.deleteMany({});
    configure({ catalogEventSource: paged(history) });
    expect(await catchUpOrgEvents()).toEqual({ ...CLEAN, applied: 4 });

    expect(await snapshot()).toEqual(before);
  });
});
