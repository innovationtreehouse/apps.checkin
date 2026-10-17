import { beforeAll, expect, it } from "vitest";
import { describeDb } from "../helpers/db";
import { initDb, prisma } from "../../db";
import { resetDb } from "../helpers/db";
import { recordTransition, emitOrgEvent, eventsSince, transactionWithEvents } from "../../services/orgEventService";
import { configureCatalog } from "../../runtime";
import type { OrgEventConsumer, OrgEventRecord } from "../../contract";

beforeAll(async () => {
  await initDb();
});

describeDb("recordTransition", () => {
  it("inserts a workflow transition log row inside a transaction", async () => {
    await resetDb();
    await prisma.$transaction(async (tx) => {
      await recordTransition(tx, "conversion_challenge", 42, "pending", "accepted", 7);
    });
    const rows = await prisma.workflowTransitionLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].workflowType).toBe("conversion_challenge");
    expect(rows[0].recordId).toBe(42);
    expect(rows[0].fromStatus).toBe("pending");
    expect(rows[0].toStatus).toBe("accepted");
    expect(rows[0].transitionedByUserId).toBe(7);
    expect(rows[0].note).toBeNull();
  });

  it("stores optional note when provided", async () => {
    await resetDb();
    await prisma.$transaction(async (tx) => {
      await recordTransition(tx, "reference_conflict", 1, "open", "use_proposed", null, "admin override");
    });
    const rows = await prisma.workflowTransitionLog.findMany();
    expect(rows[0].note).toBe("admin override");
    expect(rows[0].transitionedByUserId).toBeNull();
  });

  it("handles null userId and stores null in the log", async () => {
    await resetDb();
    await prisma.$transaction(async (tx) => {
      await recordTransition(tx, "item_reference_proposal", 5, "pending", "rejected", null);
    });
    const rows = await prisma.workflowTransitionLog.findMany();
    expect(rows[0].transitionedByUserId).toBeNull();
  });
});

describeDb("emitOrgEvent", () => {
  it("inserts an org event row with correct eventType and orgId", async () => {
    await resetDb();
    await prisma.$transaction(async (tx) => {
      await emitOrgEvent(tx, "org-123", {
        eventType: "conversion_challenge_accepted",
        version: 1,
        challengeId: 10,
        itemReferenceId: 3,
        previousFactor: 1,
        acceptedFactor: 5,
        conversionVersion: 2,
      });
    });
    const rows = await prisma.orgEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].orgId).toBe("org-123");
    expect(rows[0].eventType).toBe("conversion_challenge_accepted");
  });

  it("serializes payload without the eventType field", async () => {
    await resetDb();
    await prisma.$transaction(async (tx) => {
      await emitOrgEvent(tx, "org-456", {
        eventType: "conversion_challenge_rejected",
        version: 1,
        challengeId: 7,
        itemReferenceId: 2,
        proposedFactor: 3,
      });
    });
    const rows = await prisma.orgEvent.findMany();
    const payload = JSON.parse(rows[0].payload as string);
    expect(payload.eventType).toBeUndefined();
    expect(payload.challengeId).toBe(7);
    expect(payload.proposedFactor).toBe(3);
  });

  it("inserts separate rows for different orgs in same transaction", async () => {
    await resetDb();
    await prisma.$transaction(async (tx) => {
      await emitOrgEvent(tx, "org-A", { eventType: "conversion_challenge_rejected", version: 1, challengeId: 1, itemReferenceId: 1, proposedFactor: 1 });
      await emitOrgEvent(tx, "org-B", { eventType: "conversion_challenge_rejected", version: 1, challengeId: 2, itemReferenceId: 2, proposedFactor: 2 });
    });
    const rows = await prisma.orgEvent.findMany();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.orgId).sort()).toEqual(["org-A", "org-B"]);
  });
});

const rejectedEvent = (challengeId: number) => ({
  eventType: "conversion_challenge_rejected" as const,
  version: 1 as const,
  challengeId,
  itemReferenceId: 1,
  proposedFactor: 1,
});

function register(consumers: Record<string, OrgEventConsumer>) {
  configureCatalog({ auth: { getPrincipal: async () => null }, org: async () => ({ id: "org-1", name: "Org" }), orgEventConsumers: consumers });
}

describeDb("transactionWithEvents", () => {
  it("hands the committed events to every consumer after the commit", async () => {
    await resetDb();
    const seen: Array<{ committed: number; events: OrgEventRecord[] }> = [];
    register({
      a: { onOrgEvents: async (events) => void seen.push({ committed: await prisma.orgEvent.count(), events }) },
    });

    await transactionWithEvents(async (tx) => {
      await emitOrgEvent(tx, "org-1", rejectedEvent(1));
      await emitOrgEvent(tx, "org-1", rejectedEvent(2));
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].committed).toBe(2);
    expect(seen[0].events.map((e) => e.eventType)).toEqual(["conversion_challenge_rejected", "conversion_challenge_rejected"]);
    expect(JSON.parse(seen[0].events[1].payload).challengeId).toBe(2);
  });

  it("keeps the commit and still calls later consumers when one throws", async () => {
    await resetDb();
    let called = false;
    register({
      broken: { onOrgEvents: async () => { throw new Error("down"); } },
      ok: { onOrgEvents: async () => { called = true; } },
    });

    await transactionWithEvents(async (tx) => emitOrgEvent(tx, "org-1", rejectedEvent(3)));

    expect(called).toBe(true);
    expect(await prisma.orgEvent.count()).toBe(1);
  });

  it("calls no consumer when the transaction rolls back or emits nothing", async () => {
    await resetDb();
    let calls = 0;
    register({ a: { onOrgEvents: async () => { calls++; } } });

    await expect(transactionWithEvents(async (tx) => {
      await emitOrgEvent(tx, "org-1", rejectedEvent(4));
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await transactionWithEvents(async () => undefined);

    expect(calls).toBe(0);
    expect(await prisma.orgEvent.count()).toBe(0);
  });
});

describeDb("eventsSince", () => {
  it("returns the org's events after an id, oldest first", async () => {
    await resetDb();
    register({});
    await transactionWithEvents(async (tx) => {
      await emitOrgEvent(tx, "org-1", rejectedEvent(5));
      await emitOrgEvent(tx, "org-2", rejectedEvent(6));
      await emitOrgEvent(tx, "org-1", rejectedEvent(7));
    });
    const [first] = await eventsSince("org-1", 0);

    const rest = await eventsSince("org-1", first.id);

    expect(rest.map((e) => JSON.parse(e.payload).challengeId)).toEqual([7]);
  });
});
