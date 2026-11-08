/** The Problems list's ports: in-kind gifts whose QuickBooks post failed, timed by their first failure, and their retry. */
import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { retryStuckItem, stuckItems } from "../../stuckItems";
import { writeSettlement } from "../../lib/in-kind-poster";
import { describeDb } from "../helpers/db";
import { configureTestRuntime, TEST_ORG_ID } from "../helpers/factories";

const first = new Date("2026-11-02T10:00:00Z");
const SYSTEM = { actorUserId: null, actorUsername: "system:test", correlationId: null };

beforeEach(async () => {
  configureTestRuntime();
  await db.workflowEvent.deleteMany({});
  await db.inKindPosting.deleteMany({});
});

const posting = (giftId: number, data: { matchState: string; qbFirstFailedAt?: Date; qbLastError?: string }, orgId = TEST_ORG_ID) =>
  db.inKindPosting.create({ data: { orgId, source: "manual", giftId, ...data } });

describeDb("stuckItems", () => {
  it("lists this org's stuck gifts timed by their first failure, and leaves out the rest", async () => {
    await posting(1, { matchState: "NEEDS_FINANCE", qbFirstFailedAt: first, qbLastError: "timeout" });
    await posting(2, { matchState: "NEEDS_FINANCE" });
    await posting(3, { matchState: "CREATED", qbFirstFailedAt: first });
    await posting(4, { matchState: "NEEDS_FINANCE", qbFirstFailedAt: first }, "00000000-0000-0000-0000-000000000099");

    expect(await stuckItems()).toEqual([{ id: "manual 1", step: "QuickBooks posting", href: "/donations/in-kind/manual/1", failedAt: first }]);
  });

  it("carries no error text", async () => {
    await posting(1, { matchState: "NEEDS_FINANCE", qbFirstFailedAt: first, qbLastError: "secret detail" });

    expect(JSON.stringify(await stuckItems())).not.toContain("secret detail");
  });

  it("a second failure keeps the first failure time and saves the latest error", async () => {
    const row = await posting(1, { matchState: "POSTING", qbFirstFailedAt: first, qbLastError: "first error" });
    const gift = { source: "manual" as const, id: 1, entityType: "manual_in_kind" as const, entityId: "1" };

    await writeSettlement(db, TEST_ORG_ID, gift, row, { state: "NEEDS_FINANCE", note: "second error", entries: [], failure: "system" }, SYSTEM, {});

    expect(await stuckItems()).toEqual([expect.objectContaining({ id: "manual 1", failedAt: first })]);
    expect(await db.inKindPosting.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ qbFirstFailedAt: first, qbLastError: "second error" });
  });

  it("a retry of a gift that is not stuck, or of an unknown step, answers 404", async () => {
    await posting(2, { matchState: "NEEDS_FINANCE" });
    await posting(3, { matchState: "NEEDS_FINANCE", qbFirstFailedAt: first });
    await expect(retryStuckItem({ id: "manual 2", step: "QuickBooks posting" })).rejects.toMatchObject({ status: 404 });
    await expect(retryStuckItem({ id: "manual 9", step: "QuickBooks posting" })).rejects.toMatchObject({ status: 404 });
    await expect(retryStuckItem({ id: "other 3", step: "QuickBooks posting" })).rejects.toMatchObject({ status: 404 });
    await expect(retryStuckItem({ id: "manual 3", step: "nonsense" })).rejects.toMatchObject({ status: 404 });
  });
});
