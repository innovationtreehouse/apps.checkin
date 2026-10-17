/**
 * Bulk-donation dev/test seed (#1280 §9). Imports one Benevity file through the
 * real upload path: disbursement SEED-D1 matches the seeded account rule and
 * completes; SEED-D2's company has no rule, so it lands on hold. Every gift is
 * comment-less (organizational-level), so no owner is needed. Idempotent: a
 * re-run finds the seeded gifts and writes nothing.
 */
import * as dotenv from "dotenv";
import { configureBulkDonation } from "../src/runtime";
import { getPrisma } from "../src/db";
import { parseBenevityCsv } from "../src/lib/csv-parser";
import { uploadedFileService } from "../src/services/uploadedFileService";

dotenv.config();

// The org id the host injects (checkin's single-org accessor).
const ORG_ID = "treehouse";

const HEADER =
  "Company Name,Corporate / Peer Campaign,Disbursement ID,Disbursement Date,Transaction ID,Donation Date,Donation Amount,Match Amount,Merchant Fee,Donor First Name,Donor Last Name,Donor Comment";
const CSV = [
  HEADER,
  "Acme Corp,Giving 2026,SEED-D1,2026-09-01,seed-tx-1,2026-08-15,100.00,100.00,2.50,Ada,Lovelace,",
  "Acme Corp,Giving 2026,SEED-D1,2026-09-01,seed-tx-2,2026-08-16,25.00,0,0.75,Grace,Hopper,",
  "Globex,Match Month,SEED-D2,2026-09-02,seed-tx-3,2026-08-20,50.00,50.00,1.25,Alan,Turing,",
].join("\n");

async function main(): Promise<void> {
  // Fixture rows must never reach a live ledger; only the local/flow env seeds.
  if (process.env.CHECKIN_ENV !== "local") {
    throw new Error(`Refusing to seed bulk donation: CHECKIN_ENV is "${process.env.CHECKIN_ENV ?? ""}", not "local".`);
  }
  if (!process.env.BULK_DONATION_DATABASE_URL) {
    throw new Error("BULK_DONATION_DATABASE_URL is not set — the bulk-donation seed needs a database.");
  }
  const db = getPrisma();
  configureBulkDonation({
    auth: { getPrincipal: async () => ({ id: 0, name: "seed" }) },
    org: async () => ({ id: ORG_ID, name: "Treehouse" }),
  });

  if (!(await db.accountMap.findFirst({ where: { orgId: ORG_ID, companyName: "Acme Corp" } }))) {
    await db.accountMap.create({
      data: {
        orgId: ORG_ID,
        companyName: "Acme Corp",
        corporatePeerCampaign: "*",
        donationAccount: "Contributions:Corporate Giving",
        matchAccount: "Contributions:Corporate Match",
        feesAccount: "Fees:Benevity",
      },
    });
  }

  if (!(await db.transaction.findFirst({ where: { orgId: ORG_ID, transactionId: "seed-tx-1" } }))) {
    const buffer = Buffer.from(CSV);
    await uploadedFileService.processUpload(ORG_ID, 0, "seed", "seed-benevity.csv", buffer, parseBenevityCsv(buffer), null);
  }
  await db.$disconnect();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
