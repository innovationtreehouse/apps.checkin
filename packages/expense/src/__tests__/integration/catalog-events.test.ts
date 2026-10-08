/**
 * S5 consumer — consumeCatalogEvent driven with the shared contract fixtures
 * (seam "S5-org-events"), plus the cursor catch-up and both arrival orders of the
 * provisional dance (event after ingest, event before ingest).
 */
import { describe, it, expect } from "vitest";
import { fixture } from "@inventory/receipt-contract-fixtures";
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

describeDb("S5 consumer — catch-up sweep", () => {
  it("replays a failed event and reads past the cursor from the catalog", async () => {
    const first = envelope(approved, 10);
    await db.expenseReceivedOrgEvent.create({
      data: { id: 10, orgId: ORG, eventType: first.eventType, payload: first.payload, receivedAt: new Date(), status: "failed", failureReason: "x" },
    });
    const later = envelope(rejected, 11);
    let askedAfter = -1;
    bindPorts({ catalogEvents: { eventsAfter: async (after) => { askedAfter = after; return [later]; } } });

    expect(await catchUpCatalogEvents()).toEqual({ processed: 2, duplicate: 0, failed: 0 });

    expect(askedAfter).toBe(10);
    expect(await db.expenseReceivedOrgEvent.count({ where: { status: "processed" } })).toBe(2);
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
