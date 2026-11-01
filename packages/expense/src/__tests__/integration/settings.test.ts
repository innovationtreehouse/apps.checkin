/** Org money thresholds: defaults, audited updates, and the rules that read them. */
import { describe, it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { financeQueueRows } from "../../services/financeQueueService";
import { principal, ORG } from "../helpers/seed";
import { DEFAULT_EXPENSE_SETTINGS, getExpenseSettings, updateExpenseSettings } from "../../services/settingsService";
import { receiveCompletedReceipt } from "../../services/intakeService";

const FINANCE = principal(3, { isFinance: true });

describe("updateExpenseSettings — guards", () => {
  it("asserts the org", async () => {
    await expect(updateExpenseSettings("org-other", { boardReviewTotalCents: 1 }, FINANCE)).rejects.toThrow(/not this org/);
  });

  it("only FINANCE or the board edits", async () => {
    await expect(updateExpenseSettings(ORG, { boardReviewTotalCents: 1 }, principal(9))).rejects.toMatchObject({ status: 403 });
  });

  it.each([{ boardReviewTotalCents: 0 }, { boardReviewTotalCents: -1 }, { capitalLineItemThresholdCents: 1.5 }, { capitalEquipmentUnitCents: 50_000 }, { bogus: 1 }])(
    "rejects %j",
    async (patch) => {
      await expect(updateExpenseSettings(ORG, patch, FINANCE)).rejects.toThrow();
    },
  );
});

describeDb("expense settings", () => {
  it("holds the QuickBooks limits to finance lowers, the Board raises", async () => {
    await expect(updateExpenseSettings(ORG, { qbMaxCreatesPerDay: 60 }, FINANCE)).rejects.toMatchObject({ status: 403 });
    await updateExpenseSettings(ORG, { qbMaxCreatesPerDay: 40 }, FINANCE);
    await updateExpenseSettings(ORG, { qbMaxCreatesPerDay: 60 }, principal(5, { isBoard: true }));
    expect(await db.expenseOrgSettingsChange.count({ where: { orgId: ORG } })).toBe(2);
  });

  it("refuses a per-run limit above the per-day limit", async () => {
    await expect(updateExpenseSettings(ORG, { qbMaxCreatesPerDay: 10 }, FINANCE)).rejects.toMatchObject({ status: 400 });
  });

  it("lets finance move the match window either way, within 1 to 30", async () => {
    await updateExpenseSettings(ORG, { qbMatchWindowDays: 30 }, FINANCE);
    await updateExpenseSettings(ORG, { qbMatchWindowDays: 1 }, FINANCE);
    await expect(updateExpenseSettings(ORG, { qbMatchWindowDays: 31 }, FINANCE)).rejects.toThrow();
    await expect(updateExpenseSettings(ORG, { qbMatchWindowDays: 0 }, FINANCE)).rejects.toThrow();
  });

  it("a missing row reads as the defaults", async () => {
    expect(await getExpenseSettings(ORG)).toEqual(DEFAULT_EXPENSE_SETTINGS);
    expect(DEFAULT_EXPENSE_SETTINGS).toMatchObject({
      boardReviewTotalCents: 200_000,
    });
  });

  it("an update changes only the patched fields and records old and new values", async () => {
    const next = await updateExpenseSettings(ORG, { boardReviewTotalCents: 100_000 }, FINANCE);
    expect(next).toEqual({ ...DEFAULT_EXPENSE_SETTINGS, boardReviewTotalCents: 100_000 });
    await updateExpenseSettings(ORG, { boardReviewTotalCents: 150_000 }, principal(5, { isBoard: true }));

    const changes = await db.expenseOrgSettingsChange.findMany({ where: { orgId: ORG }, orderBy: { id: "asc" } });
    expect(changes.map((c) => [c.actorUserId, JSON.parse(c.before!), JSON.parse(c.after)])).toEqual([
      [3, { boardReviewTotalCents: 200_000 }, { boardReviewTotalCents: 100_000 }],
      [5, { boardReviewTotalCents: 100_000 }, { boardReviewTotalCents: 150_000 }],
    ]);
  });

  it("the Board tab reads the configured Board-review total", async () => {
    await updateExpenseSettings(ORG, { boardReviewTotalCents: 1_000 }, FINANCE);
    await receiveCompletedReceipt({
      receiptId: "r-thresholds",
      orgId: ORG,
      submitterId: 1,
      vendorName: "Acme",
      receiptNumber: null,
      orderNumber: null,
      taxCents: 0,
      shippingCents: 0,
      discountCents: 0,
      receiptTotalCents: 1_000,
      receiptDate: "2026-10-01",
      needsReimbursement: false,
      reimbursementFor: null,
      submittedAt: new Date().toISOString(),
      lineItems: [{ receiptLineItemId: 1, lineNumber: 1, description: "Drill", partNumber: null, manufacturer: null, quantity: 1, unitPriceCents: 1_000, totalPriceCents: 1_000, isDelayed: false }],
    });

    const rows = await financeQueueRows(principal(3, { isFinance: true }), "board");
    expect(rows.map((r) => r.expenseId)).toEqual(["r-thresholds"]);
    expect(rows[0].reasons.map((x) => x.code)).toContain("BOARD_APPROVAL");
  });
});
