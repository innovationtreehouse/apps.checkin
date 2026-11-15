import { getPrisma as getReceiptPrisma } from "@checkin/receipt";
import prisma from "../src/lib/prisma";
import { config } from "../src/lib/config";
import { currentDatabase, DevDataCheckRefused, isAllowedDatabase, runDevDataCheck } from "../src/lib/dev/dataCheck";

/**
 * Reports how much non-seeded data dev holds (docs/in-design/DEV_RESET.md, "How it is proven gone").
 * Prints counts to stdout for the workflow log; it writes nothing anywhere.
 *
 *   npm run dev-data-check                          (local, from checkin-app/)
 *   node checkin-app/dev-data-check.mjs             (dev, one-off task in the image)
 */

// Receipts are counted for information only; they are mostly anonymous and outside the check.
// A receipt database that is not dev's refuses the whole run; an unreachable one reads "unavailable".
async function countReceipts(): Promise<number | "unavailable"> {
    const receipts = getReceiptPrisma();
    let name: string;
    try {
        name = await currentDatabase(receipts);
    } catch {
        return "unavailable";
    }
    if (!isAllowedDatabase(config.checkinEnv(), name, process.env.RECEIPT_DATABASE_URL, "receipt")) {
        throw new DevDataCheckRefused("dev-data-check refuses to read a receipt database that is not dev's");
    }
    try {
        return await receipts.receipt.count();
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
    .catch((error: unknown) => {
        console.error(
            error instanceof DevDataCheckRefused ? "dev-data-check refused: not the dev database" : "dev-data-check failed",
        );
        process.exit(1);
    });
