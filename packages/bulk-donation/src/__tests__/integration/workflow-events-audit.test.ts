/**
 * Audit / workflow-history store (workflow_events).
 *
 * Proves the lifecycle is reconstructable (C3) and every state-changing action
 * records who / when / what / why (H7): owner assignment is actor-attributed,
 * holds are recorded created and resolved, and completion is logged with its
 * payload — all atomically with the business writes.
 */
import { it, expect, beforeEach } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { transactionService } from "../../services/transactionService";
import { sendDisbursementEvent } from "../../workflows/disbursement.actor";
import { makeFile, makeTransaction, makeAccountMapRule, configureTestRuntime, TEST_ORG_ID } from "../helpers/factories";

const orgId = TEST_ORG_ID;
let fileId: number;
const AUDIT = { actorUserId: 1, actorUsername: "testfinance", correlationId: "corr-test-1" };
const assignOwner = (id: number, ownerId: number) => transactionService.assignOwner(orgId, id, ownerId, false, AUDIT);

function eventsFor(disbursementId: string) {
  return db.workflowEvent.findMany({
    where: { orgId, disbursementId },
    orderBy: { id: "asc" },
  });
}

beforeEach(async () => {
  await db.workflowEvent.deleteMany({});
  await db.disbursementEvent.deleteMany({});
  await db.disbursementHold.deleteMany({});
  await db.disbursementSnapshot.deleteMany({});
  await db.transactionCommentRule.deleteMany({});
  await db.transaction.deleteMany({});
  await db.uploadedFile.deleteMany({});
  await db.accountMap.deleteMany({});
  fileId = (await makeFile(orgId)).id;
  configureTestRuntime();
});

describeDb("owner assignment is actor-attributed", () => {
  it("records an OWNER_ASSIGNED event with userId, username and correlation id", async () => {
    const tx = await makeTransaction(orgId, fileId, { disbursementId: "audit-1", ownerId: null });
    await makeAccountMapRule(orgId);

    await assignOwner(tx.id, 9);

    const evts = await eventsFor("audit-1");
    const assigned = evts.find((e) => e.eventType === "OWNER_ASSIGNED");
    expect(assigned).toBeDefined();
    expect(assigned!.actorUserId).toBe(1);
    expect(assigned!.actorUsername).toBe("testfinance");
    expect(assigned!.correlationId).toBe("corr-test-1");
    expect(assigned!.entityType).toBe("transaction");
  });

  it("logs the completing transition and DISBURSEMENT_COMPLETED with payload, attributed to the actor", async () => {
    const tx = await makeTransaction(orgId, fileId, { disbursementId: "audit-2", ownerId: null, donationAmountCents: 5000 });
    await makeAccountMapRule(orgId);

    await assignOwner(tx.id, 9);

    const evts = await eventsFor("audit-2");
    const types = evts.map((e) => e.eventType);
    expect(types).toContain("STATE_TRANSITION");
    expect(types).toContain("DISBURSEMENT_COMPLETED");

    const completed = evts.find((e) => e.eventType === "DISBURSEMENT_COMPLETED")!;
    expect(completed.actorUserId).toBe(1);
    const payload = JSON.parse(completed.payload!);
    expect(payload.items.find((i: { type: string }) => i.type === "donation").amountCents).toBe(5000);
  });
});

describeDb("hold lifecycle is recorded", () => {
  it("records HOLD_CREATED then HOLD_RESOLVED across a hold/resubmit cycle", async () => {
    // No rule -> on_hold.
    const tx = await makeTransaction(orgId, fileId, { disbursementId: "audit-3", ownerId: null, companyName: "Unknown Corp" });
    await assignOwner(tx.id, 9);

    let evts = await eventsFor("audit-3");
    expect(evts.some((e) => e.eventType === "HOLD_CREATED")).toBe(true);
    expect(evts.some((e) => e.eventType === "STATE_TRANSITION")).toBe(true);

    // Add the rule, resubmit (system-driven here) -> resolves + completes.
    await makeAccountMapRule(orgId, { companyName: "Unknown Corp" });
    await sendDisbursementEvent(orgId, "audit-3", { type: "HOLD_RESUBMITTED" });

    evts = await eventsFor("audit-3");
    expect(evts.some((e) => e.eventType === "HOLD_RESOLVED")).toBe(true);
    expect(evts.some((e) => e.eventType === "DISBURSEMENT_COMPLETED")).toBe(true);
  });
});

describeDb("atomicity", () => {
  it("commits the owner write, the hold, and the audit events together in one transaction", async () => {
    const tx = await makeTransaction(orgId, fileId, { disbursementId: "audit-4", ownerId: null, companyName: "Unknown Corp" });
    await assignOwner(tx.id, 9);

    // Owner persisted AND hold + audit persisted together.
    const [row] = await db.transaction.findMany({ where: { id: tx.id } });
    expect(row.ownerId).toBe(9);
    const holds = await db.disbursementHold.findMany({
      where: { orgId, disbursementId: "audit-4" },
    });
    expect(holds).toHaveLength(1);
    const evts = await eventsFor("audit-4");
    expect(evts.some((e) => e.eventType === "OWNER_ASSIGNED")).toBe(true);
    expect(evts.some((e) => e.eventType === "HOLD_CREATED")).toBe(true);
  });
});
