/** A capital review send never throws: a failure is recorded on the gift, keeping its first failure time, and a success clears it. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ServiceError } from "@checkin/component-kit";

const state = vi.hoisted(() => ({ submit: async (): Promise<void> => undefined, writes: [] as { where: unknown; data: unknown }[] }));

const GIFT = {
  id: 5,
  receiptId: "r-5",
  receiptTotalCents: 2500,
  receiptDate: "2026-09-01",
  moneyReceivedAt: null,
  donorRecordedAt: null,
  donorLastName: null,
  donorReplacedAt: null,
  replayConflictAt: null,
  uploadedByUserId: 7,
  decisionOutcome: "ACCEPTED",
  decidedByUserId: 10,
  decidedAt: new Date(),
  budgetOwnerId: 1,
  bucketAssignedAt: new Date(),
  capitalSubmittedAt: null,
  lines: [{ id: 1, gtin13: null, description: "Drill", quantity: 1, valueCents: 2500, quickBooksAccountId: null }],
};

vi.mock("../../db", () => ({
  db: {
    inKindDonation: {
      count: async () => 1,
      findMany: async () => [GIFT],
      updateMany: async (args: { where: unknown; data: unknown }) => {
        state.writes.push(args);
        return { count: 1 };
      },
    },
  },
}));
vi.mock("../../runtime", () => ({ getInKindCapital: () => ({ submit: () => state.submit() }) }));

import { inKindCapitalSend } from "../../services/inKindAcceptService";

const resend = () => inKindCapitalSend.resendCapitalReview("org-1", "receipt", 5);

describe("capital review send", () => {
  beforeEach(() => {
    state.writes = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it.each([
    ["an outage", new ServiceError(503, "expense down"), "system"],
    ["a refusal", new ServiceError(422, "bad line"), "data"],
    ["a 403", new ServiceError(403, "Forbidden"), "bug"],
    ["an unbranded error", new Error("boom"), "bug"],
  ])("%s is answered as its kind and recorded, never thrown", async (_, thrown, kind) => {
    state.submit = async () => { throw thrown; };
    await expect(resend()).resolves.toBe(kind);
    expect(state.writes).toEqual([
      { where: { id: 5, capitalFirstFailedAt: null }, data: { capitalFirstFailedAt: expect.any(Date) } },
      { where: { id: 5 }, data: { capitalLastError: thrown.message } },
    ]);
  });

  it("a success stamps the send and clears the failure", async () => {
    state.submit = async () => undefined;
    await expect(resend()).resolves.toBe("sent");
    expect(state.writes).toEqual([{ where: { id: 5 }, data: { capitalSubmittedAt: expect.any(Date), capitalFirstFailedAt: null, capitalLastError: null } }]);
  });

  it("a failure to record the failure is only logged", async () => {
    state.submit = async () => { throw new Error("boom"); };
    const { db } = await import("../../db");
    vi.spyOn(db.inKindDonation, "updateMany").mockRejectedValue(new Error("db down"));
    await expect(resend()).resolves.toBe("bug");
  });
});
