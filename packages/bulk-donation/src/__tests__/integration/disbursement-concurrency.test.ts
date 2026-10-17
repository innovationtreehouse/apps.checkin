/**
 * Concurrency / optimistic-lock behaviour of sendDisbursementEvent.
 *
 * The actor guards snapshot writes with a version check and retries on
 * OptimisticLockError (up to MAX_RETRIES). These tests fire overlapping
 * cycles on the SAME disbursement and assert the end state is consistent —
 * no duplicate events, no duplicate pending holds, no thrown error.
 */
import { it, expect, beforeEach } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { sendDisbursementEvent } from "../../workflows/disbursement.actor";
import { makeFile, makeTransaction, makeAccountMapRule, TEST_ORG_ID } from "../helpers/factories";

const orgId = TEST_ORG_ID;
let fileId: number;

beforeEach(async () => {
  await db.disbursementEvent.deleteMany({});
  await db.disbursementHold.deleteMany({});
  await db.disbursementSnapshot.deleteMany({});
  await db.transaction.deleteMany({});
  await db.uploadedFile.deleteMany({});
  await db.accountMap.deleteMany({});
  fileId = (await makeFile(orgId)).id;
});

describeDb("concurrent successful processing", () => {
  it("produces exactly one disbursement event when many cycles race", async () => {
    const disbursementId = "race-success";
    await makeTransaction(orgId, fileId, { disbursementId, ownerId: 1, companyName: "Acme Corp" });
    await makeAccountMapRule(orgId, { companyName: "Acme Corp" });

    // Fire five overlapping OWNER_ASSIGNED cycles.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        sendDisbursementEvent(orgId, disbursementId, { type: "OWNER_ASSIGNED", allReady: true }),
      ),
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const events = await db.disbursementEvent.findMany({
      where: { orgId, disbursementId },
    });
    expect(events).toHaveLength(1);

    // Terminal — snapshot removed.
    const snap = await db.disbursementSnapshot.findFirst({
      where: { orgId, disbursementId },
    });
    expect(snap).toBeNull();
  });
});

describeDb("concurrent hold creation", () => {
  it("survives racing cycles and leaves exactly one pending hold per conflicting tx", async () => {
    const disbursementId = "race-hold";
    // No account map rule → every cycle lands on_hold.
    await makeTransaction(orgId, fileId, { disbursementId, ownerId: 1, companyName: "Unknown Corp" });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        sendDisbursementEvent(orgId, disbursementId, { type: "OWNER_ASSIGNED", allReady: true }),
      ),
    );
    // Optimistic-lock retries must absorb the races without surfacing an error.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    // Exactly one snapshot row, still on_hold.
    const snaps = await db.disbursementSnapshot.findMany({
      where: { orgId, disbursementId },
    });
    expect(snaps).toHaveLength(1);
    expect(snaps[0].state).toBe("on_hold");

    // Holds are not duplicated: prior PENDING gets RESOLVED before a fresh one is written,
    // so at most one PENDING per (single) conflicting transaction remains.
    const holds = await db.disbursementHold.findMany({
      where: { orgId, disbursementId },
    });
    expect(holds.filter((h) => h.status === "PENDING")).toHaveLength(1);

    // No event was emitted while unresolved.
    const events = await db.disbursementEvent.findMany({
      where: { orgId, disbursementId },
    });
    expect(events).toHaveLength(0);
  });
});

describeDb("concurrent resubmit + completion", () => {
  it("completes once when a resubmit races a duplicate resubmit", async () => {
    const disbursementId = "race-resubmit";
    await makeTransaction(orgId, fileId, { disbursementId, ownerId: 1, companyName: "Unknown Corp" });

    // First land it on_hold.
    await sendDisbursementEvent(orgId, disbursementId, { type: "OWNER_ASSIGNED", allReady: true });

    // Add the missing rule, then race two resubmits.
    await makeAccountMapRule(orgId, { companyName: "Unknown Corp" });
    const results = await Promise.allSettled([
      sendDisbursementEvent(orgId, disbursementId, { type: "HOLD_RESUBMITTED" }),
      sendDisbursementEvent(orgId, disbursementId, { type: "HOLD_RESUBMITTED" }),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const events = await db.disbursementEvent.findMany({
      where: { orgId, disbursementId },
    });
    expect(events).toHaveLength(1);

    const holds = await db.disbursementHold.findMany({
      where: { orgId, disbursementId },
    });
    expect(holds.every((h) => h.status === "RESOLVED")).toBe(true);

    const snap = await db.disbursementSnapshot.findFirst({
      where: { orgId, disbursementId },
    });
    expect(snap).toBeNull();
  });
});
