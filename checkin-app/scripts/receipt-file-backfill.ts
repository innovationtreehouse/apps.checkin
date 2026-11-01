import { backfillFiles, getPrisma, verifyFiles } from "@checkin/receipt";
import { retryP1001UntilDeadline } from "../src/lib/auroraResumeRetry";
import { config } from "../src/lib/config";
import { receiptFileStore } from "../src/lib/receipt/fileStore";

/**
 * One-off copy of receipt and held-mail files from the database to the file store
 * (docs/ops/receipt-files-backfill.md).
 *
 *   node checkin-app/receipt-file-backfill.mjs [--verify]
 *
 * The production image carries this bundled; the Dockerfile builds it. Exits non-zero unless the
 * run finished clean.
 */

const AURORA_RESUME_DEADLINE_MS = 5 * 60_000;

async function main(): Promise<boolean> {
    const verify = process.argv.includes("--verify");
    await retryP1001UntilDeadline(() => getPrisma().$queryRaw`SELECT 1`, AURORA_RESUME_DEADLINE_MS);
    if (!config.isLocal() && !config.receiptFilesBucket()) {
        console.error("RECEIPT_FILES_S3_BUCKET is not set; nothing was copied or verified.");
        return false;
    }
    if (verify) {
        const report = await verifyFiles(receiptFileStore());
        console.log(JSON.stringify({ mode: "verify", ...report }, null, 2));
        return [report.noKey, report.missing, report.mismatches, report.failures].every((list) => list.length === 0);
    }
    const report = await backfillFiles(receiptFileStore());
    console.log(JSON.stringify({ mode: "backfill", ...report }, null, 2));
    return report.mismatches.length === 0 && report.failures.length === 0;
}

main()
    .then((clean) => process.exit(clean ? 0 : 1))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
