import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { logger } from "@/lib/logger";
import { handler } from "@/security/handler";
import { config } from "@/lib/config";
import { countSyncRuns, latestSyncRun } from "@/lib/shopifyRead/client";
import { relTime } from "@/lib/time";

/**
 * GET /api/finance-ops/s-read/diagnose — walk the s-read feature's dependency
 * chain and report the FIRST broken link with its specific cause.
 *
 * Why this exists (docs/ops/shopify-mirror.md): the sync-status feature
 * sits at the end of a nine-link chain (env → derived URL → network → auth → DB
 * exists → table exists → SELECT grant → rows exist → trigger IAM), and without
 * this endpoint every broken link collapses into "the status line doesn't render"
 * or one generic red toast. configHealth can't help — it is presence-only by
 * design because it runs on nav-badge polls, and anything touching the mirror
 * wakes the scale-to-zero Aurora cluster.
 *
 * ON-DEMAND ONLY. A human clicked "Run diagnostics" on the system-status page.
 * Never poll or cron this: every probe is a paid Aurora wake-up — the same cost
 * that makes the automatic sync daily rather than continuous.
 *
 * The mirror probe is deliberately ONE query, not six checks: the pg error code
 * from `SELECT count(*) FROM sync_run` discriminates every layer on its own
 * (see classifyMirrorError). The trigger probe is a Lambda DryRun invoke —
 * validates IAM permission and function existence without running a sync, under
 * the same lambda:InvokeFunction grant the POST already uses.
 *
 * SECURITY — never returns a connection string, credential, or raw error
 * message (pg messages can embed host detail). Host + database name only, and
 * our own sentences keyed on the error code; the raw error goes to the server
 * log. Same board/sysadmin gate as the sync route.
 */

export type DiagStep = {
    /** Stable slug: env | mirror-read | latest-run | clock | trigger-env | trigger-invoke. */
    id: string;
    /** null = skipped because an earlier step already failed. */
    ok: boolean | null;
    /** Human sentence — never a secret, never a raw driver message. */
    detail: string;
    /** pg SQLSTATE / node errno / AWS error name, when there is one. */
    code?: string;
};

/**
 * Map a mirror-read failure to the layer it proves broken. Order matters only
 * for readability — the codes are mutually exclusive. Node system errors
 * (ENOTFOUND/ECONNREFUSED/ETIMEDOUT) surface on err.code just like pg SQLSTATEs;
 * pool connection timeouts carry no code at all, only a "timeout" message.
 */
function classifyMirrorError(err: unknown, dbName: string): { detail: string; code?: string } {
    const e = err as { code?: string; message?: string };
    switch (e.code) {
        case "ENOTFOUND":
        case "ECONNREFUSED":
        case "ETIMEDOUT":
            return {
                code: e.code,
                detail: "Can't reach the mirror host — network / security-group / cluster-paused problem, not a grant problem.",
            };
        case "28P01":
        case "28000":
            return { code: e.code, detail: "Host reached, but checkin's credential was rejected." };
        case "3D000":
            return {
                code: e.code,
                detail: `Connected, but database "${dbName}" doesn't exist — check SHOPIFY_READ_DB spelling and that bootstrap created the DB.`,
            };
        case "42P01":
            return {
                code: e.code,
                detail: "Database exists, but the sync_run table is missing — s-read has never migrated this mirror.",
            };
        case "42501":
            return {
                code: e.code,
                detail: "Table exists, but SELECT is denied — checkin's DML role isn't a member of the mirror's NOLOGIN grant-holder yet (infra#136 bootstrap step).",
            };
    }
    if (/timeout/i.test(e.message ?? "")) {
        return { detail: "Timed out connecting to the mirror — network / security-group / cluster-paused problem." };
    }
    return {
        code: e.code,
        detail: "Mirror read failed for an unrecognised reason — see the server log for the raw error.",
    };
}

const skipped = (id: string): DiagStep => ({ id, ok: null, detail: "Skipped — an earlier step already failed." });

export const GET = handler(
    "GET /api/finance-ops/s-read/diagnose",
    async () => {
        const steps: DiagStep[] = [];

        // env — pure inspection, no I/O. Which resolution path won, and where it
        // points (host + db name only — never the credential part of the URL).
        const url = config.shopifyReadDatabaseUrl();
        const source = process.env.SHOPIFY_READ_DATABASE_URL ? "SHOPIFY_READ_DATABASE_URL (local override)" : "DATABASE_URL + SHOPIFY_READ_DB";
        let dbName = "";
        if (url) {
            const parsed = new URL(url);
            dbName = parsed.pathname.replace(/^\//, "");
            steps.push({ id: "env", ok: true, detail: `Resolved via ${source}: database "${dbName}" on ${parsed.hostname}.` });
        } else {
            steps.push({
                id: "env",
                ok: false,
                detail: process.env.DATABASE_URL
                    ? "Not wired — SHOPIFY_READ_DB is unset (and no SHOPIFY_READ_DATABASE_URL override)."
                    : "Not wired — DATABASE_URL itself is unset, so no mirror URL can be derived.",
            });
        }

        // mirror-read — links 2–7 as ONE probe; the error code discriminates them.
        let runs: number | null = null;
        if (!url) {
            steps.push(skipped("mirror-read"));
        } else {
            try {
                runs = await countSyncRuns();
                steps.push(
                    runs === 0
                        ? { id: "mirror-read", ok: false, detail: "Mirror is readable but s-read has never started a run — trigger a sync or check s-read's own logs." }
                        : { id: "mirror-read", ok: true, detail: `Mirror readable; ${runs} sync run(s) recorded.` },
                );
            } catch (error) {
                logger.error("[s-read diagnose] mirror probe failed:", error);
                steps.push({ id: "mirror-read", ok: false, ...classifyMirrorError(error, dbName) });
            }
        }

        // latest-run + clock — only meaningful once the mirror has rows.
        if (!runs) {
            steps.push(skipped("latest-run"), skipped("clock"));
        } else {
            try {
                // Non-null: runs > 0 was just observed, and this endpoint is a
                // human-paced click — no concurrent writer deletes sync runs.
                const run = (await latestSyncRun())!;
                steps.push({
                    id: "latest-run",
                    // FAILED/ABANDONED is s-read's own reported outcome — a real answer,
                    // surfaced red so the operator reads s-read's error text.
                    ok: run.status === "FAILED" || run.status === "ABANDONED" ? false : true,
                    detail:
                        `${run.kind} ${run.status}, started ${relTime(run.startedAt)}` +
                        (run.finishedAt ? `, finished ${relTime(run.finishedAt)}` : "") +
                        (run.error ? ` — s-read error: ${run.error}` : "") +
                        `.`,
                });
                const ageMs = Date.now() - run.startedAt.getTime();
                steps.push(
                    ageMs < 0
                        ? {
                              id: "clock",
                              ok: false,
                              detail: `Latest run's startedAt is ${Math.round(-ageMs / 60000)} min in the FUTURE — timezone handling regression (see #1042). Process TZ: ${process.env.TZ ?? "(unset)"}.`,
                          }
                        : { id: "clock", ok: true, detail: `Timestamps sane; latest run started ${relTime(run.startedAt)}. Process TZ: ${process.env.TZ ?? "(unset)"}.` },
                );
            } catch (error) {
                logger.error("[s-read diagnose] latest-run read failed:", error);
                steps.push({ id: "latest-run", ok: false, detail: "Counting runs worked but reading the latest failed — see the server log." }, skipped("clock"));
            }
        }

        // trigger-env — separate wiring from the mirror; an env can have either
        // without the other (same split the sync route's POST/GET gates encode).
        const fn = config.sReadTriggerFunction();
        steps.push(
            fn
                ? { id: "trigger-env", ok: true, detail: `S_READ_TRIGGER_FUNCTION = ${fn}.` }
                : { id: "trigger-env", ok: false, detail: "S_READ_TRIGGER_FUNCTION is unset — the 'Sync Shopify now' button 503s." },
        );

        // trigger-invoke — DryRun validates IAM + function existence, runs nothing.
        if (!fn) {
            steps.push(skipped("trigger-invoke"));
        } else {
            try {
                const client = new LambdaClient({ region: config.awsRegion() });
                await client.send(new InvokeCommand({ FunctionName: fn, InvocationType: "DryRun" }));
                steps.push({ id: "trigger-invoke", ok: true, detail: "Trigger Lambda exists and this app is permitted to invoke it (dry run — no sync started)." });
            } catch (error) {
                logger.error("[s-read diagnose] trigger dry-run failed:", error);
                const name = (error as { name?: string }).name;
                steps.push({
                    id: "trigger-invoke",
                    ok: false,
                    code: name,
                    detail:
                        name === "AccessDeniedException"
                            ? "IAM denies lambda:InvokeFunction on the trigger — the app's grant is missing or names a different ARN."
                            : name === "ResourceNotFoundException"
                              ? "No Lambda by that name in this region — S_READ_TRIGGER_FUNCTION is misspelled or points at another environment."
                              : "Dry-run invoke failed for an unrecognised reason — see the server log.",
                });
            }
        }

        return { SReadDiagnoseStep: steps };
    },
);
