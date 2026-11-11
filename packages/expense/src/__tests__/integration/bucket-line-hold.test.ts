/**
 * The host's org-level → program change holds a bucket against new lines: every path that puts a
 * line in the bucket waits until the change commits, so the count it refuses on stays true.
 */
import { waitersBehind } from "@checkin/pg-test-harness";
import { it, expect, beforeEach } from "vitest";
import { db } from "../../db";
import { describeDb } from "../helpers/db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem, seedPartOwner, ORG } from "../helpers/seed";
import { holdBucketLines } from "../../services/signoffService";
import { assignOwner, financeAssign, resolveUnknown } from "../../services/approvalService";
import { initFinancialFlow } from "../../lib/financial-flow";

const BUCKET = 7;
const NOT_EVERYDAY = 60_000;
const FINANCE = principal(3, { isFinance: true });
const GTIN = "0000000000017";

async function line(state: string, ownerId: number | null, status: string) {
  const id = await seedExpense({ state, receiptTotalCents: NOT_EVERYDAY });
  const lineItemId = await seedLineItem(id, { gtin13: GTIN });
  return { id, approvalId: await seedApproval(id, lineItemId, { ownerId, status }) };
}

/** The backend holding the bucket's hold exclusively. */
async function holderPid(): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const [row] = await db.$queryRaw<{ pid: number }[]>`
      SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = ${BUCKET}::oid AND mode = 'ExclusiveLock' AND granted`;
    if (row) return row.pid;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("nobody holds the bucket");
}

const paths: [string, () => Promise<() => Promise<void>>][] = [
  ["assignOwner", async () => {
    const { id, approvalId } = await line("assign_ownership", null, "pending");
    return () => assignOwner(FINANCE, id, approvalId, BUCKET);
  }],
  ["resolveUnknown", async () => {
    const { id, approvalId } = await line("assign_ownership", null, "unknown");
    return () => resolveUnknown(FINANCE, id, approvalId, BUCKET);
  }],
  ["financeAssign", async () => {
    const { id, approvalId } = await line("owner_approval", 100, "exception_raised");
    return () => financeAssign(FINANCE, id, approvalId, BUCKET);
  }],
  ["initFinancialFlow", async () => {
    const id = await seedExpense({ state: "pending", receiptTotalCents: NOT_EVERYDAY });
    await seedLineItem(id, { gtin13: GTIN });
    await seedPartOwner({ gtin13: GTIN, ownerId: BUCKET });
    return () => initFinancialFlow(id, ORG);
  }],
];

describeDb("holding a bucket against new lines", () => {
  beforeEach(() => bindPorts({ signoff: directory({ orgLevel: [BUCKET], approvers: { 100: [2] }, finance: [3], board: [5, 6] }) }));

  it.each(paths)("%s waits for the hold, and the count taken under it stays true", async (_name, setup) => {
    const put = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let counted = -1;
    const hold = holdBucketLines(BUCKET, async (awaiting) => {
      counted = await awaiting();
      await gate;
    });

    const pid = await holderPid();
    const putting = put();
    await waitersBehind(db, pid);
    release();
    await Promise.all([hold, putting]);

    expect(counted).toBe(0);
    expect(await db.lineItemOwnerApproval.count({ where: { ownerId: BUCKET } })).toBe(1);
  }, 20_000);
});
