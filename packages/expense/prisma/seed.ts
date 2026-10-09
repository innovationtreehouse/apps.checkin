/**
 * Expense dev/flow seed (#1272 §12). Writes expenses the screens and flow tests exercise
 * without the receipt pipeline. Idempotent, so a re-run is safe.
 *
 * Person and bucket ids are checkin's, from a fresh baseline seed: bucket 1 is "Facility"
 * (org-level), bucket 2 is the first program's; person 10 is tool.certifier@example.com, an
 * active member, as the submitter.
 */
import * as dotenv from "dotenv";
import { getPrisma } from "../src/db";

dotenv.config();

const ORG_ID = "treehouse";
const FACILITY_BUCKET = 1;
const PROGRAM_BUCKET = 2;
const SUBMITTER = 10;

interface SeedExpense {
  id: string;
  state: string;
  vendorName: string;
  totalCents: number;
  needsReimbursement?: boolean;
  approval: { ownerId: number | null; status: string };
  hold?: string;
  flag?: { kind: string; audience: string };
}

const EXPENSES: SeedExpense[] = [
  // A program-bucket card charge waiting on its bucket approvers.
  { id: "seed-expense-program", state: "owner_approval", vendorName: "Seed Lumber", totalCents: 4200, approval: { ownerId: PROGRAM_BUCKET, status: "pending" } },
  // A line no part map placed: FINANCE assigns its bucket.
  { id: "seed-expense-unassigned", state: "assign_ownership", vendorName: "Seed Hardware", totalCents: 1500, approval: { ownerId: null, status: "pending" } },
  // An org-level line held because no account rule matched; a tax flag for FINANCE.
  {
    id: "seed-expense-held",
    state: "qb_on_hold",
    vendorName: "Seed Electric",
    totalCents: 9900,
    approval: { ownerId: FACILITY_BUCKET, status: "approved" },
    hold: "NO_MATCH",
    flag: { kind: "TAX_ATTACHED", audience: "FINANCE" },
  },
  // A reimbursement whose receipt named no reimbursee: held until FINANCE sets one.
  {
    id: "seed-expense-reimbursement",
    state: "assign_ownership",
    vendorName: "Seed Supplies",
    totalCents: 2500,
    needsReimbursement: true,
    approval: { ownerId: null, status: "pending" },
    flag: { kind: "REIMBURSEE_UNKNOWN", audience: "FINANCE" },
  },
];

async function main(): Promise<void> {
  // Fixture rows must never reach a live ledger; only the local/flow env seeds.
  if (process.env.CHECKIN_ENV !== "local") {
    throw new Error(`Refusing to seed expense: CHECKIN_ENV is "${process.env.CHECKIN_ENV ?? ""}", not "local".`);
  }
  if (!process.env.EXPENSE_DATABASE_URL) throw new Error("EXPENSE_DATABASE_URL is not set — the expense seed needs a database.");
  const db = getPrisma();

  for (const [i, e] of EXPENSES.entries()) {
    if (await db.expense.findUnique({ where: { id: e.id } })) continue;
    await db.$transaction(async (tx) => {
      await tx.expense.create({
        data: {
          id: e.id,
          orgId: ORG_ID,
          submitterId: SUBMITTER,
          vendorName: e.vendorName,
          receiptTotalCents: e.totalCents,
          receiptDate: "2026-10-01",
          needsReimbursement: e.needsReimbursement ?? false,
          submittedAt: new Date("2026-10-02T12:00:00Z"),
          state: e.state,
        },
      });
      const line = await tx.expenseLineItem.create({
        data: {
          expenseId: e.id,
          receiptLineItemId: i + 1,
          lineNumber: 1,
          description: `${e.vendorName} item`,
          partNumber: `SEED-${i + 1}`,
          unitPriceCents: e.totalCents,
          totalPriceCents: e.totalCents,
        },
      });
      await tx.lineItemOwnerApproval.create({ data: { expenseId: e.id, lineItemId: line.id, ...e.approval } });
      if (e.hold) {
        await tx.expenseHold.create({ data: { orgId: ORG_ID, expenseId: e.id, lineItemId: line.id, reason: e.hold, matchedRows: "[]" } });
      }
      if (e.flag) await tx.expenseFlag.create({ data: { orgId: ORG_ID, expenseId: e.id, ...e.flag } });
    });
  }
  console.log("Expense seed complete.");
  await db.$disconnect();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
