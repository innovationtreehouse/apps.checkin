import { beforeAll, expect, it } from "vitest";
import { describeDb } from "@/__tests__/helpers/db";
import { initDb, prisma } from "@/db";
import { resetDb } from "@/__tests__/helpers/db";
import { recordTransition, emitOrgEvent } from "@/services/orgEventService";

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
