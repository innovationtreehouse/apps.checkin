import { describe, expect, it } from "vitest";
import { qbKey } from "@checkin/quickbooks";
import { parseExpected, statusOf, type ExpectedDeposit } from "../../lib/intake";
import { closedNote, CLOSED_NOTE, rowKeys } from "../../lib/sources";
import { matchWindow } from "../../lib/reconcile";
import type { PayoutReconciliation } from "../../generated/prisma/client";

const deposit: ExpectedDeposit = {
  txnDate: "2026-06-28",
  netCents: 900,
  bankRole: "BENEVITY_BANK",
  lines: [
    { role: "BENEVITY_DONATIONS", budgetOwnerId: 7, amountCents: 1000 },
    { role: "BENEVITY_FEES", budgetOwnerId: null, amountCents: -100 },
  ],
};

describe("parseExpected", () => {
  it("keeps a valid deposit, in one key order whatever order it arrived in", () => {
    const shuffled = { lines: deposit.lines, bankRole: deposit.bankRole, netCents: 900, txnDate: "2026-06-28" } as ExpectedDeposit;
    expect(JSON.stringify(parseExpected(shuffled))).toBe(JSON.stringify(parseExpected(deposit)));
  });

  it.each([
    [{ txnDate: "28/06/2026" }, /YYYY-MM-DD/],
    [{ netCents: 0 }, /positive/],
    [{ bankRole: "NOPE" }, /books-map role/],
    [{ lines: [] }, /at least one line/],
    [{ netCents: 901 }, /sum to 900/],
    [{ lines: [{ role: "BENEVITY_FEES", budgetOwnerId: 0, amountCents: 900 }] }, /budgetOwnerId/],
  ])("refuses %j", (patch, message) => {
    expect(() => parseExpected({ ...deposit, ...patch } as ExpectedDeposit)).toThrow(message);
  });
});

const row = (over: Partial<PayoutReconciliation>) => ({ status: "WAITING", kind: null, resolution: null, origin: null, depositId: null, reason: null, qbNote: null, depositTxnDate: null, depositTotalCents: null, ...over }) as PayoutReconciliation;

describe("statusOf", () => {
  it("names each state the handing lane reads", () => {
    expect(statusOf(row({}))).toEqual({ state: "waiting" });
    expect(statusOf(row({ status: "OPEN", kind: "NO_DEPOSIT", qbNote: "n" }))).toEqual({ state: "with_finance", kind: "NO_DEPOSIT", note: "n" });
    expect(statusOf(row({ status: "OPEN", kind: "DRIFT" }))).toEqual({ state: "drifted", note: null });
    expect(statusOf(row({ status: "RESOLVED", resolution: "DISMISSED", reason: "booked elsewhere" }))).toEqual({ state: "dismissed", reason: "booked elsewhere" });
    expect(statusOf(row({ status: "POSTED", origin: "created", depositId: "1", depositTxnDate: "2026-06-28", depositTotalCents: 900 })))
      .toEqual({ state: "booked", depositId: "1", txnDate: "2026-06-28", totalCents: 900 });
    expect(statusOf(row({ status: "RESOLVED", resolution: "MANUAL", origin: "matched", depositId: "2" }))).toMatchObject({ state: "matched", depositId: "2" });
  });
});

describe("per-source rules", () => {
  it("keys a Benevity row apart from a Shopify payout of the same key", () => {
    expect(rowKeys({ source: "shopify", payoutGid: "P1" })).toEqual([qbKey("income", "P1")]);
    expect(rowKeys({ source: "benevity", payoutGid: "P1" })).toEqual([qbKey("income", "benevity:P1")]);
  });

  it("gives a Benevity deposit donation's ±7-day window", () => {
    expect(matchWindow("2026-06-10", "benevity")).toEqual({ from: "2026-06-03", to: "2026-06-17" });
  });

  it("notes a Benevity deposit uploaded after switch-on but dated in closed books", () => {
    expect(closedNote({ source: "benevity", payoutDate: "2026-05-01" }, true)).toMatch(/Uploaded after posting was switched on, but dated 2026-05-01/);
    expect(closedNote({ source: "benevity", payoutDate: "2026-05-01" }, false)).toBe(CLOSED_NOTE);
    expect(closedNote({ source: "shopify", payoutDate: "2026-05-01" }, true)).toBe(CLOSED_NOTE);
  });
});
