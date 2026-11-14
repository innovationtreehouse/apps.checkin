import { getPrisma as getReceiptPrisma } from "@checkin/receipt";
import prisma from "../src/lib/prisma";
import { runDevDataCheck } from "../src/lib/dev/dataCheck";

/**
 * Reports how much non-seeded data dev holds (docs/in-design/DEV_RESET.md, "How it is proven gone").
 * Prints counts to stdout for the workflow log; it writes nothing anywhere.
 *
 *   npm run dev-data-check                          (local, from checkin-app/)
 *   node checkin-app/dev-data-check.mjs             (dev, one-off task in the image)
 */

// Receipts are counted for information only; they are mostly anonymous and outside the check.
async function countReceipts(): Promise<number | "unavailable"> {
    try {
        return await getReceiptPrisma().receipt.count();
    } catch {
        return "unavailable";
    }
}

// Error text stays out of the output: workflow logs are public, and a connection error names hosts.
async function main(): Promise<void> {
    const report = await runDevDataCheck(prisma);
    const receipts = await countReceipts();
    console.log(JSON.stringify({ ...report, receiptsForInformation: receipts }, null, 2));
}

main()
    .then(() => process.exit(0))
    .catch(() => {
        console.error("dev-data-check failed");
        process.exit(1);
    });
