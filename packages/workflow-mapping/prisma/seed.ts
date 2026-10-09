/**
 * Workflow-mapping dev/test seed (#1289 §10). The receipt library is not wired
 * yet (S1 is X6), so this writes received receipts directly for the screens and
 * flow tests: one waiting on a line decision, and one whose lines are all
 * resolved but not yet proceeded (as after a catalog remap). Idempotent, so a
 * re-run is safe.
 */
import * as dotenv from "dotenv";
import type { CompletedReceipt } from "@inventory/receipt-types";
import { getPrisma } from "../src/db";

dotenv.config();

// The org id the host injects; rows stamped with any other id are invisible to the routes.
const ORG_ID = "treehouse";
const RECOGNIZED_GTIN = "0022222222220";

function receipt(receiptId: string, vendorName: string, lines: Array<[string, number, boolean]>): CompletedReceipt {
  return {
    receiptId,
    orgId: ORG_ID,
    submitterId: 1,
    vendorName,
    receiptNumber: null,
    orderNumber: null,
    currency: "USD",
    taxCents: 0,
    shippingCents: 0,
    discountCents: 0,
    receiptTotalCents: lines.length * 500,
    receiptDate: "2026-10-01",
    needsReimbursement: false,
    reimbursementFor: null,
    submittedAt: new Date().toISOString(),
    backfill: false,
    isInKind: false,
    lineItems: lines.map(([description, quantity, isDelayed], i) => ({
      receiptLineItemId: i + 1,
      lineNumber: i + 1,
      description,
      partNumber: null,
      manufacturer: null,
      quantity,
      unitPriceCents: 500,
      totalPriceCents: 500 * quantity,
      isDelayed,
    })),
  };
}

const SEEDS: Array<{ receipt: CompletedReceipt; recognized: boolean[] }> = [
  { receipt: receipt("seed-wm-mapping", "Seed Supply", [["Hex bolts", 2, false], ["Shop towels", 1, false]]), recognized: [true, false] },
  { receipt: receipt("seed-wm-proceed", "Seed Hardware", [["Hex bolts", 5, false]]), recognized: [true] },
];

async function main(): Promise<void> {
  // Fixture rows must never reach a live database; only the local/flow env seeds.
  if (process.env.CHECKIN_ENV !== "local") {
    throw new Error(`Refusing to seed workflow mapping: CHECKIN_ENV is "${process.env.CHECKIN_ENV ?? ""}", not "local".`);
  }
  if (!process.env.WORKFLOW_MAPPING_DATABASE_URL) {
    throw new Error("WORKFLOW_MAPPING_DATABASE_URL is not set — the workflow-mapping seed needs a database.");
  }
  const db = getPrisma();

  for (const { receipt: r, recognized } of SEEDS) {
    if (await db.receivedReceipt.findUnique({ where: { receiptId: r.receiptId } })) continue;
    await db.receivedReceipt.create({
      data: {
        orgId: ORG_ID,
        receiptId: r.receiptId,
        state: "pending_review",
        receiptJson: JSON.stringify(r),
        lineStatuses: {
          create: r.lineItems.map((li, i) => ({
            receiptLineItemId: li.receiptLineItemId,
            recognitionStatus: recognized[i] ? "recognized" : "unrecognized",
            assignedGtin13: recognized[i] ? RECOGNIZED_GTIN : null,
          })),
        },
      },
    });
  }

  console.log(`🌱 Workflow-mapping seed complete: ${SEEDS.length} received receipts.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await getPrisma().$disconnect();
  });
