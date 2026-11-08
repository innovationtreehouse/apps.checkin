/** Finance's release of a fees-only hold: only a pending FEES_ONLY hold of that org and disbursement is released. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = vi.hoisted(() => ({ hold: null as unknown, updates: [] as string[], cycle: vi.fn(), handOver: vi.fn(), events: [] as string[] }));
const tx = {
  disbursementHold: {
    findFirst: vi.fn(async () => calls.hold),
    update: vi.fn(async () => { calls.updates.push("hold"); }),
  },
  transaction: { update: vi.fn(async () => { calls.updates.push("transaction"); }) },
};
vi.mock("../../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db")>()),
  db: { $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) },
}));
vi.mock("../../workflows/disbursement.actor", () => ({
  lockDisbursementTx: async () => {},
  runDisbursementCycleTx: calls.cycle,
}));
vi.mock("../../lib/deposit-handover", () => ({ handOverDeposit: calls.handOver }));
vi.mock("../../repositories/audit", () => ({
  recordEvent: async (_tx: unknown, e: { eventType: string }) => { calls.events.push(e.eventType); },
}));

import { disbursementService } from "../../services/disbursementService";

const audit = { actorUserId: 7, actorUsername: "Finance", correlationId: "c1" };
const pending = { id: 3, orgId: "org-1", disbursementId: "d1", transactionId: 11, reason: "FEES_ONLY", status: "PENDING" };
const release = () => disbursementService.releaseFeesOnlyHold("org-1", "d1", 3, audit);

beforeEach(() => {
  calls.updates = [];
  calls.events = [];
  calls.cycle.mockReset();
  calls.handOver.mockReset();
  tx.disbursementHold.findFirst.mockClear();
});

describe("releaseFeesOnlyHold", () => {
  it.each([
    ["another reason", { ...pending, reason: "NO_MATCH" }],
    ["an already released hold", { ...pending, status: "RELEASED" }],
    ["a hold of another disbursement or org", null],
  ])("refuses %s with a 409 and changes nothing", async (_name, hold) => {
    calls.hold = hold;
    await expect(release()).rejects.toMatchObject({ status: 409 });
    expect(calls.updates).toEqual([]);
    expect(calls.cycle).not.toHaveBeenCalled();
    expect(calls.handOver).not.toHaveBeenCalled();
  });

  it("looks the hold up by org and disbursement", async () => {
    calls.hold = null;
    await release().catch(() => {});
    expect(tx.disbursementHold.findFirst).toHaveBeenCalledWith({ where: { id: 3, orgId: "org-1", disbursementId: "d1" } });
  });

  it("stamps the row, releases the hold, records who, reruns the cycle and hands the deposit over", async () => {
    calls.hold = pending;
    await release();
    expect(tx.transaction.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { feeReleasedAt: expect.any(Date), feeReleasedByUserId: 7, feeReleasedByName: "Finance" },
    });
    expect(tx.disbursementHold.update).toHaveBeenCalledWith({ where: { id: 3 }, data: { status: "RELEASED", resolvedAt: expect.any(Date) } });
    expect(calls.events).toEqual(["HOLD_RELEASED"]);
    expect(calls.cycle).toHaveBeenCalledWith(tx, "org-1", "d1", { type: "HOLD_RESUBMITTED" }, audit);
    expect(calls.handOver).toHaveBeenCalledWith("org-1", "d1");
  });
});
