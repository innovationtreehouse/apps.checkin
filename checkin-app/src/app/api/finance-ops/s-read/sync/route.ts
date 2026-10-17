import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { logger } from "@/lib/logger";
import { ApiResponseError, handler } from "@/security/handler";
import { config } from "@/lib/config";
import prisma from "@/lib/prisma";
import { personActor } from "@/lib/auditActor";
import { isConfigured, latestSyncRun } from "@/lib/shopifyRead/client";

/**
 * POST /api/finance-ops/s-read/sync — the board forces an s-read incremental sync
 * now, instead of waiting for the daily 09:00 UTC tick.
 *
 * The reconciler (api/cron/reconcile-shopify) reads a mirror that s-read refreshes
 * once a day, so a payment problem fixed in Shopify this morning still shows as OPEN
 * on the payments queue until tomorrow. This button closes that gap: it re-reads
 * Shopify into the mirror, after which the next reconcile run sees current truth.
 *
 * Invokes the `s-read-<env>-trigger` Lambda — the same entry point the EventBridge
 * schedule uses, which RunTasks the sync family with a SYNC_MODE override
 * (s-read-function/DEPLOY.md). This is deliberately NOT a direct ecs:RunTask from
 * here: the trigger Lambda already owns the cluster/task-def/network wiring, so
 * reusing it keeps this app's IAM grant to a single lambda:InvokeFunction on a
 * single function ARN, and keeps checkin out of the s-read VPC entirely.
 *
 * SECURITY — the mode is a hardcoded literal and the request body is never read.
 * The trigger Lambda also accepts {"mode":"backfill"}, which submits a Shopify Bulk
 * Operation; letting a caller name the mode would turn one board click into an
 * API-budget burn. The IAM grant must likewise cover ONLY this function — never
 * s-replay-function, whose replay/reset-watermark ops re-project financial history
 * and are IAM-gated with mandatory actor/reason audit by design.
 *
 * Concurrency is s-read's problem and s-read already solves it: reserved
 * concurrency = 1 plus the per-store `withSyncRun` lock means a second run while one
 * is in flight is skipped, not corrupted.
 *
 * The trigger is audited before the invoke, as a SREAD_SYNC row with no entity
 * (affectedEntityId 0), so no sync starts without an actor on record. s-read stamps
 * its own `sync_run`.
 *
 * GET on the same path reports the latest run's status — see below.
 */
export const POST = handler(
    "POST /api/finance-ops/s-read/sync",
    async ({ auth }) => {
        if (auth.type !== 'session') throw new ApiResponseError(401, "Unauthorized");

        const functionName = config.sReadTriggerFunction();
        if (!functionName) {
            throw new ApiResponseError(503, "Shopify sync is not wired in this environment");
        }

        try {
            await prisma.auditLog.create({
                data: {
                    ...personActor(auth.user.id),
                    action: "CREATE",
                    tableName: "SREAD_SYNC",
                    affectedEntityId: 0,
                    newData: { mode: "incremental" },
                },
            });
            const client = new LambdaClient({ region: config.awsRegion() });
            await client.send(
                new InvokeCommand({
                    FunctionName: functionName,
                    // RequestResponse, not Event: the trigger Lambda only calls RunTask and
                    // returns — it does not wait for the sync itself — so this stays fast
                    // while still surfacing a failed invoke to the board member instead of
                    // silently succeeding.
                    InvocationType: "RequestResponse",
                    Payload: JSON.stringify({ mode: "incremental" }),
                }),
            );

            logger.info(`[s-read] manual incremental sync triggered by user ${auth.user.id}`);
            return { SReadSyncTrigger: { success: true } };
        } catch (error) {
            logger.error("Failed to trigger s-read sync:", error);
            throw new ApiResponseError(500, "Failed to start the Shopify sync");
        }
    },
);

/**
 * GET /api/finance-ops/s-read/sync — the latest s-read run, so the payments page can
 * say how fresh "Live payment" is and tell whether a sync it just started has landed.
 *
 * Gated on the MIRROR, not on the trigger the POST gates on: the two are separate
 * wiring (the mirror connection vs S_READ_TRIGGER_FUNCTION), and an env can
 * legitimately have one without the other. Unwired → 503, matching the POST, so the
 * page can just hide the status line rather than special-case a success body that
 * means "no answer".
 *
 * Same board/sysadmin gate as the POST. `sync_run` is operational metadata (status,
 * kind, timings, row counts) about the store as a whole — no per-person or
 * per-order data — but it rides the same queue-level boundary as the rest of
 * finance-ops rather than being widened for no caller.
 *
 * The status is read verbatim from the mirror; the caller decides what to do with a
 * value it does not recognise (s-read owns that enum and may extend it).
 */
export const GET = handler(
    "GET /api/finance-ops/s-read/sync",
    async () => {
        if (!isConfigured()) {
            throw new ApiResponseError(503, "The Shopify mirror is not wired in this environment");
        }

        try {
            return { SyncRun: await latestSyncRun() };
        } catch (error) {
            logger.error("Failed to read the s-read sync status:", error);
            throw new ApiResponseError(500, "Failed to read the Shopify sync status");
        }
    },
);
