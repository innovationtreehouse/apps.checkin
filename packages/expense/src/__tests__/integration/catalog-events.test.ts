/**
 * S5 consumer — consumeCatalogEvent driven with the shared contract fixtures
 * (seam "S5-org-events"), plus the catch-up sweep and both arrival orders of the
 * provisional dance (event after ingest, event before ingest).
 */
import { describe, it, expect, vi } from "vitest";
import { fixture } from "@checkin/receipt-contract-fixtures";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, ORG } from "../helpers/seed";
import { catchUpCatalogEvents, consumeCatalogEvent } from "../../services/catalogEventConsumer";
import { receiveCompletedReceipt } from "../../services/intakeService";

type Ev = { eventType: string; provisionalGtin13: string; realGtin13?: string; rejectionReason?: string };
const approved = fixture<Ev>("S5-org-events/provisional-approved");
const mapped = fixture<Ev>("S5-org-events/provisional-mapped-to-existing");
const rejected = fixture<Ev>("S5-org-events/provisional-rejected");
const itemRef = fixture<Ev>("S5-org-events/item-reference-proposal-approved");
const hasProvisional = fixture<{ receiptId: string; lineItems: Array<{ gtin13?: string | null; isProvisional?: boolean }> }>(
  "S2-expense-receipt/has-provisional",
);

let nextId = 1;
function envelope(ev: Ev, id = nextId++) {
  const { eventType, ...payload } = ev;
  return { id, orgId: ORG, eventType, payload: JSON.stringify(payload), createdAt: new Date().toISOString() };
}

const provisional = (gtin: string) => db.provisionalItemMap.findFirst({ where: { orgId: ORG, provisionalGtin13: gtin } });
const ownerOf = async (gtin: string) => (await db.partOwnerMap.findFirst({ where: { orgId: ORG, gtin13: gtin } }))?.ownerId ?? null;
const track = (gtin: string) => db.provisionalItemMap.create({ data: { orgId: ORG, provisionalGtin13: gtin } });

describe("S5 consumer — envelope guard", () => {
  it("rejects an event for another org", async () => {
    await expect(consumeCatalogEvent({ ...envelope(approved), orgId: "org-other" })).rejects.toThrow(/not this org/);
  });
});

describeDb("S5 consumer — fixtures", () => {
  it("provisional_approved remaps the row and carries the bucket onto the real GTIN", async () => {
    await track(approved.provisionalGtin13);
    await db.partOwnerMap.create({ data: { orgId: ORG, gtin13: approved.provisionalGtin13, ownerId: 42 } });

    expect(await consumeCatalogEvent(envelope(approved))).toBe("processed");

    expect(await provisional(approved.provisionalGtin13)).toMatchObject({ status: "approved", resolvedToGtin13: approved.realGtin13 });
    expect(await ownerOf(approved.realGtin13!)).toBe(42);
  });

  it("provisional_mapped_to_existing remaps to the existing GTIN", async () => {
    await track(mapped.provisionalGtin13);
    await consumeCatalogEvent(envelope(mapped));
    expect(await provisional(mapped.provisionalGtin13)).toMatchObject({ status: "mapped_to_existing", resolvedToGtin13: mapped.realGtin13 });
  });

  it("provisional_rejected marks the row rejected with the contract reason", async () => {
    await track(rejected.provisionalGtin13);
    await consumeCatalogEvent(envelope(rejected));
    expect(await provisional(rejected.provisionalGtin13)).toMatchObject({ status: "rejected", rejectionReason: rejected.rejectionReason, resolvedToGtin13: null });
  });

  it("records an event it does not consume, and skips a redelivery", async () => {
    const ev = envelope(itemRef);
    expect(await consumeCatalogEvent(ev)).toBe("processed");
    expect(await consumeCatalogEvent(ev)).toBe("duplicate");
    expect(await db.expenseReceivedOrgEvent.count()).toBe(1);
  });

  it("records a payload that breaks the contract as failed, without applying anything", async () => {
    const bad = { ...envelope(approved), payload: JSON.stringify({ version: 1, provisionalGtin13: "X", realGtin13: 123, name: "n" }) };

    expect(await consumeCatalogEvent(bad)).toBe("failed");

    const row = await db.expenseReceivedOrgEvent.findFirst({ where: { id: bad.id } });
    expect(row).toMatchObject({ status: "failed" });
    expect(await db.expenseProvisionalResolution.count()).toBe(0);
  });
});

/** A source that honours the id cursor and returns at most `pageSize` events, like the catalog. */
const paged = (events: Array<{ id: number }>, pageSize = 500) => ({
  eventsSince: async (_orgId: string, after: number) => events.filter((e) => e.id > after).slice(0, pageSize),
});
const malformed = (id: number) => ({ ...envelope(approved, id), payload: JSON.stringify({ version: 1, provisionalGtin13: "X", realGtin13: 123, name: "n" }) });
const CLEAN = { processed: 0, duplicate: 0, failed: 0, unprocessed: 0, unreadable: false };

describeDb("S5 consumer — catch-up sweep", () => {
  it("replays a failed event and reads past the cursor from the catalog", async () => {
    const first = envelope(approved, 10);
    await db.expenseReceivedOrgEvent.create({
      data: { id: 10, orgId: ORG, eventType: first.eventType, payload: first.payload, receivedAt: new Date(), status: "failed", failureReason: "x" },
    });
    const later = envelope(rejected, 11);
    let askedAfter = -1;
    bindPorts({ catalogEvents: { eventsSince: async (_orgId, after) => { askedAfter = askedAfter < 0 ? after : askedAfter; return [later].filter((e) => e.id > after); } } });

    expect(await catchUpCatalogEvents()).toEqual({ ...CLEAN, processed: 2 });

    expect(askedAfter).toBe(0);
    expect(await db.expenseReceivedOrgEvent.count({ where: { status: "processed" } })).toBe(2);
  });

  it("consumes an event that committed after a higher id was already received", async () => {
    // Event 21 committed and was consumed first; event 20 committed after it.
    const late = envelope(approved, 20);
    const early = envelope(rejected, 21);
    await track(approved.provisionalGtin13);
    expect(await consumeCatalogEvent(early)).toBe("processed");
    bindPorts({ catalogEvents: { eventsSince: async (_orgId, after) => [late, early].filter((e) => e.id > after) } });

    expect(await catchUpCatalogEvents()).toEqual({ ...CLEAN, processed: 1 });

    expect(await provisional(approved.provisionalGtin13)).toMatchObject({ status: "approved", resolvedToGtin13: approved.realGtin13 });
  });

  it("consumes an event lost more than 100 ids behind the newest", async () => {
    await track(approved.provisionalGtin13);
    const later = Array.from({ length: 150 }, (_, i) => envelope(itemRef, i + 8));
    for (const ev of later) await consumeCatalogEvent(ev);
    bindPorts({ catalogEvents: paged([envelope(approved, 7), ...later]) });

    expect(await catchUpCatalogEvents()).toEqual({ ...CLEAN, processed: 1 });

    expect(await provisional(approved.provisionalGtin13)).toMatchObject({ status: "approved", resolvedToGtin13: approved.realGtin13 });
  });

  it("reads every page of the catalog, however long its history", async () => {
    bindPorts({ catalogEvents: paged([1, 2, 3, 4, 5].map((id) => envelope(itemRef, id)), 2) });
    expect(await catchUpCatalogEvents()).toEqual({ ...CLEAN, processed: 5 });
  });

  it("a capped run drains over later runs without alerting", async () => {
    const orgEventsStuck = vi.fn(async () => {});
    bindPorts({ catalogEvents: paged([1, 2, 3].map((id) => envelope(itemRef, id))), alerts: { orgEventsStuck } });

    expect(await catchUpCatalogEvents(2)).toEqual({ ...CLEAN, processed: 2, unprocessed: 1 });
    expect(await catchUpCatalogEvents(2)).toEqual({ ...CLEAN, processed: 1 });
    expect(orgEventsStuck).not.toHaveBeenCalled();
  });

  it("failures that keep failing leave room in the cap for new events", async () => {
    const bad = [1, 2, 3, 4].map(malformed);
    for (const ev of bad) await consumeCatalogEvent(ev);
    bindPorts({ catalogEvents: paged([...bad, envelope(itemRef, 5)]) });

    expect(await catchUpCatalogEvents(4)).toEqual({ ...CLEAN, processed: 1, failed: 3, unprocessed: 1 });
  });

  it("a failed overlap does not overwrite a processed ledger row", async () => {
    const ev = malformed(30);
    // The overlapping consumer's success lands after this one read the ledger.
    const spy = vi.spyOn(db.expenseReceivedOrgEvent, "findFirst").mockImplementationOnce((async () => {
      await db.expenseReceivedOrgEvent.create({ data: { id: 30, orgId: ORG, eventType: ev.eventType, payload: ev.payload, receivedAt: new Date(), status: "processed" } });
      return null;
    }) as unknown as typeof db.expenseReceivedOrgEvent.findFirst);
    try {
      expect(await consumeCatalogEvent(ev)).toBe("duplicate");
    } finally {
      spy.mockRestore();
    }
    expect(await db.expenseReceivedOrgEvent.findFirst({ where: { id: 30 } })).toMatchObject({ status: "processed", failureReason: null });
  });
});

describeDb("S5 consumer — catch-up alerts", () => {
  it("alerts on each run while the catalog can't be read, and still retries failures", async () => {
    const orgEventsStuck = vi.fn(async () => {});
    await consumeCatalogEvent(malformed(1));
    bindPorts({ catalogEvents: { eventsSince: async () => { throw new Error("catalog down"); } }, alerts: { orgEventsStuck } });

    expect(await catchUpCatalogEvents()).toEqual({ ...CLEAN, failed: 1, unreadable: true });
    await catchUpCatalogEvents();
    expect(orgEventsStuck).toHaveBeenCalledTimes(2);
    expect(orgEventsStuck).toHaveBeenCalledWith({ failed: 0, unprocessed: 0, unreadable: true });
  });

  it("alerts when an event first fails in the sweep, not on later retries", async () => {
    const orgEventsStuck = vi.fn(async () => {});
    bindPorts({ catalogEvents: paged([malformed(1)]), alerts: { orgEventsStuck } });

    await catchUpCatalogEvents();
    await catchUpCatalogEvents();
    expect(orgEventsStuck).toHaveBeenCalledTimes(1);
    expect(orgEventsStuck).toHaveBeenCalledWith({ failed: 1, unprocessed: 0, unreadable: false });
  });

  it("alerts when an event first fails in the call-out, not when the sweep retries it", async () => {
    const orgEventsStuck = vi.fn(async () => {});
    const bad = malformed(1);
    bindPorts({ catalogEvents: paged([bad]), alerts: { orgEventsStuck } });

    await consumeCatalogEvent(bad);
    await catchUpCatalogEvents();
    expect(orgEventsStuck).toHaveBeenCalledTimes(1);
  });

  it("alerts on each run while a capped run processes nothing", async () => {
    const orgEventsStuck = vi.fn(async () => {});
    bindPorts({ catalogEvents: paged([envelope(itemRef, 1)]), alerts: { orgEventsStuck } });

    await catchUpCatalogEvents(0);
    await catchUpCatalogEvents(0);
    expect(orgEventsStuck).toHaveBeenCalledTimes(2);
  });

  it("finishes the run when the alert itself throws", async () => {
    bindPorts({ catalogEvents: paged([malformed(1)]), alerts: { orgEventsStuck: async () => { throw new Error("mail down"); } } });
    expect(await catchUpCatalogEvents()).toEqual({ ...CLEAN, failed: 1 });
  });

  it("finishes the sweep when one event can't be recorded", async () => {
    bindPorts({ catalogEvents: paged([{ ...envelope(itemRef, 1), orgId: "org-other" }, envelope(itemRef, 2)]) });
    expect(await catchUpCatalogEvents()).toEqual({ ...CLEAN, failed: 1, processed: 1 });
  });
});

describeDb("S5 consumer — first-run replay", () => {
  it("replaying all history over current state changes nothing", async () => {
    // The catalog gives each provisional one verdict.
    const verdicts = [approved, { ...mapped, provisionalGtin13: "0009999900022" }, { ...rejected, provisionalGtin13: "0009999900039" }];
    const history = [...verdicts.map((v, i) => envelope(v, i + 1)), envelope(itemRef, 4)];
    for (const v of verdicts) await track(v.provisionalGtin13);
    await db.partOwnerMap.create({ data: { orgId: ORG, gtin13: approved.provisionalGtin13, ownerId: 42 } });
    for (const ev of history) await consumeCatalogEvent(ev);
    // A manager reassigned the real item's bucket after the verdict; a replay must keep that.
    await db.partOwnerMap.updateMany({ where: { orgId: ORG, gtin13: approved.realGtin13! }, data: { ownerId: 100 } });
    const snapshot = async () => ({
      provisionals: await db.provisionalItemMap.findMany({ orderBy: { id: "asc" } }),
      owners: await db.partOwnerMap.findMany({ orderBy: { gtin13: "asc" } }),
      // recordedAt is when the fact was last recorded, so a replay refreshes it; nothing reads it.
      resolutions: (await db.expenseProvisionalResolution.findMany({ orderBy: { id: "asc" } })).map(({ recordedAt: _recordedAt, ...fact }) => fact),
    });
    const before = await snapshot();

    await db.expenseReceivedOrgEvent.deleteMany();
    bindPorts({ catalogEvents: paged(history) });
    expect(await catchUpCatalogEvents()).toEqual({ ...CLEAN, processed: 4 });

    expect(await snapshot()).toEqual(before);
  });
});

describeDb("S5 ordering", () => {
  const gtin = approved.provisionalGtin13;

  it("the S2 and S5 fixtures share the provisional GTIN", () => {
    expect(hasProvisional.lineItems.some((l) => l.isProvisional && l.gtin13 === gtin)).toBe(true);
  });

  it("converges when the event arrives after ingest", async () => {
    await receiveCompletedReceipt(hasProvisional);
    await consumeCatalogEvent(envelope(approved));
    expect(await provisional(gtin)).toMatchObject({ status: "approved", resolvedToGtin13: approved.realGtin13 });
  });

  it("converges when the event arrives before ingest", async () => {
    await consumeCatalogEvent(envelope(approved));
    expect(await provisional(gtin)).toBeNull();

    await receiveCompletedReceipt(hasProvisional);

    expect(await provisional(gtin)).toMatchObject({ status: "approved", resolvedToGtin13: approved.realGtin13 });
  });
});
