/** A failed inventory delta on the Problems list names its receipt or gift, links to its page, and retries by that name. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const FAILED_AT = new Date("2026-11-02T10:00:00Z");
const state = vi.hoisted(() => ({ retried: [] as unknown[][] }));

vi.mock("../../lib/db", () => ({
  db: {
    receivedInventoryDelta: {
      findMany: async () => [
        { sourceKey: "receipt:rcpt-1", receiptId: "rcpt-1", receivedAt: FAILED_AT, firstFailedAt: FAILED_AT },
        { sourceKey: "donation:12", receiptId: null, receivedAt: FAILED_AT, firstFailedAt: null },
      ],
    },
    inventoryReceivedOrgEvent: { findMany: async () => [] },
    inventoryProvisionalItem: { findMany: async () => [] },
  },
}));
vi.mock("../../lib/services/orgEventConsumer", () => ({ retryOrgEvent: async () => {}, retryProvisionalReconcile: async () => {} }));
vi.mock("../../runtime", () => ({
  getOrgId: async () => "org-1",
  getServices: () => ({ receiptService: { retryFailedDelta: async (...args: unknown[]) => void state.retried.push(args) } }),
}));

import { retryStuckItem, stuckItems } from "../../stuckItems";

describe("inventory delta stuck items", () => {
  beforeEach(() => {
    state.retried = [];
  });

  it("lists a receipt's delta by receipt and a gift's by its donation key, each with its page", async () => {
    expect(await stuckItems()).toEqual([
      { id: "rcpt-1", step: "inventory delta", href: "/receipts/rcpt-1", failedAt: FAILED_AT },
      { id: "donation:12", step: "inventory delta", href: "/donations/in-kind/manual/12", failedAt: FAILED_AT },
    ]);
  });

  it("retries a gift's delta by its donation key", async () => {
    await retryStuckItem({ id: "donation:12", step: "inventory delta" });
    expect(state.retried).toEqual([["org-1", { sourceKey: "donation:12", receiptId: null }]]);
  });

  it("retries a receipt's delta by its receipt id", async () => {
    await retryStuckItem({ id: "rcpt-1", step: "inventory delta" });
    expect(state.retried).toEqual([["org-1", { receiptId: "rcpt-1" }]]);
  });
});
