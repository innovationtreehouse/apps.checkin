import { isDbUnavailableError } from '@checkin/pg-kit'
import { Prisma } from '@/generated/prisma/client'

// The cloud dev DB is Aurora Serverless v2 with min-capacity 0 + auto-pause; the
// first connection after idle races the ~30s resume and Prisma throws P1001
// ("Can't reach database server"). The deploy workflow already retries migrations
// for this same race (see .github/workflows/deploy-dev.yml). Mirror it here for the
// jwt-callback reads (auth-options.ts) so a cold start doesn't surface as NextAuth's
// generic `Callback` error. Short backoff only — this runs in the sign-in request
// path, not a one-off migrate task. Retries ONLY on P1001; rethrows everything else.
export async function withAuroraResumeRetry<T>(
    fn: () => Promise<T>,
    attempts = 5,
    delayMs = 600,
): Promise<T> {
    for (let i = 1; ; i++) {
        try {
            return await fn();
        } catch (error) {
            if (!isDbUnavailableError(error) || i >= attempts) throw error;
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
}

/**
 * Client-wide variant of the same retry, applied to EVERY Prisma operation via
 * a query extension (see lib/prisma.ts). Where withAuroraResumeRetry protects a
 * single hot path with a ~3s budget, this rides out the full ~30s resume so a
 * request that lands mid-wake completes late instead of failing with a generic
 * 500 — the DbWakeNotice banner (components/DbWakeNotice.tsx) explains the wait
 * to the user in the meantime. Retrying is safe for writes because every
 * signature below is a CONNECTION-ACQUISITION failure — the connection never
 * reached the server, so the query never ran. Mid-query drops (e.g.
 * "connection terminated unexpectedly") are deliberately NOT retried: the
 * statement may have executed.
 */
export const AURORA_RESUME_DEADLINE_MS = 45_000;
const RESUME_RETRY_DELAY_MS = 2_000;

/** Deadline-based sibling of withAuroraResumeRetry (exported for tests). */
export async function retryP1001UntilDeadline<T>(
    fn: () => Promise<T>,
    deadlineMs = AURORA_RESUME_DEADLINE_MS,
    delayMs = RESUME_RETRY_DELAY_MS,
): Promise<T> {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
        try {
            return await fn();
        } catch (error) {
            if (!isDbUnavailableError(error) || Date.now() >= deadline) throw error;
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
}

export const auroraResumeRetryExtension = Prisma.defineExtension({
    name: 'aurora-resume-retry',
    query: {
        $allOperations({ args, query }) {
            return retryP1001UntilDeadline(() => query(args));
        },
    },
});
