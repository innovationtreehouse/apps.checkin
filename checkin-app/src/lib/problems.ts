import { ServiceError, type StuckItem } from "@checkin/component-kit";
import { config } from "@/lib/config";
import { getCronJobStatuses, type CronJobStatus } from "@/lib/cronRuns";
import { sendTemplated } from "@/lib/email-templates/send";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { unreadLine } from "@/lib/problemsLines";
import { currentPostingWarnings } from "@/lib/finance/postingRuns";
import { checkEmailStuckItems, retryCheckEmail } from "@/lib/membership/positionCheck";
import { APP_TIMEZONE, formatDateTime } from "@/lib/time";

/** One stuck item on the Problems list, named by the library that holds it. */
export interface Problem extends StuckItem {
    library: string;
}

/** The person who pressed Retry. */
type ProblemRetrier = { userId: number; username: string | null };

type Retry = (item: { id: string; step: string }, by: ProblemRetrier) => Promise<void>;

/**
 * Each receipt-flow library's "stuck items" and "retry" ports, and its own Problems lines where it
 * has them; one with no database configured is not read. A source with no `env` lives in the app's
 * own database and is always read.
 */
const SOURCES: { library: string; env?: string; read: () => Promise<StuckItem[]>; retry: Retry; notices?: () => Promise<Notice[]> }[] = [
    {
        library: "receipt",
        env: "RECEIPT_DATABASE_URL",
        read: async () => (await import("@checkin/receipt")).stuckItems(),
        retry: async (item, by) => (await import("@checkin/receipt")).retryStuckItem(item, by),
        notices: async () => (await (await import("@checkin/receipt")).problemNotices()).map((text) => ({ text, href: null })),
    },
    {
        library: "workflow mapping",
        env: "WORKFLOW_MAPPING_DATABASE_URL",
        read: async () => (await import("@checkin/workflow-mapping")).stuckItems(),
        retry: async (item) => (await import("@checkin/workflow-mapping")).retryStuckItem(item),
        notices: async () => (await import("@checkin/workflow-mapping")).problemNotices(),
    },
    {
        library: "expense",
        env: "EXPENSE_DATABASE_URL",
        read: async () => (await import("@checkin/expense")).stuckItems(),
        retry: async (item, by) => (await import("@checkin/expense")).retryStuckItem(item, by),
    },
    {
        library: "gifts",
        env: "BULK_DONATION_DATABASE_URL",
        read: async () => (await import("@checkin/bulk-donation")).stuckItems(),
        retry: async (item) => (await import("@checkin/bulk-donation")).retryStuckItem(item),
    },
    {
        library: "membership",
        read: async () => (await import("@/lib/membership/settleHouseholdBg")).stuckSettles(),
        retry: async (item) => (await import("@/lib/membership/settleHouseholdBg")).retryStuckSettle(item),
    },
    {
        library: "local inventory",
        env: "LOCAL_INVENTORY_DATABASE_URL",
        read: async () => (await import("@checkin/local-inventory")).stuckItems(),
        retry: async (item) => {
            await (await import("@checkin/local-inventory")).retryStuckItem(item);
            await markGiftLoaded(item.id);
        },
    },
    {
        library: "background check",
        read: checkEmailStuckItems,
        retry: retryCheckEmail,
    },
];

const isWired = (s: { env?: string }): boolean => !s.env || Boolean(process.env[s.env]);

/**
 * After a retried `donation:<id>` load applies, bulk-donation's own load replays it (a no-op) and
 * records the gift as loaded. Never fails the retry: the gift page's "Load again" does the same.
 */
async function markGiftLoaded(id: string): Promise<void> {
    const giftId = /^donation:(\d+)$/.exec(id)?.[1];
    if (!giftId || !process.env.BULK_DONATION_DATABASE_URL) return;
    try {
        const gifts = await import("@checkin/bulk-donation");
        await gifts.manualInKindService.loadInventory(await gifts.getOrgId(), Number(giftId));
    } catch (err) {
        logger.error(`[problems] ${id} loaded, but the gift could not be marked loaded:`, err);
    }
}

/** The database env var of each library the Problems list reads. */
export const LIBRARY_DB_VARS = SOURCES.flatMap((s) => (s.env ? [s.env] : []));

/** A count line on the Problems list, with the page that shows its detail where there is one. */
export interface Notice {
    text: string;
    href: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const BOARD_AFTER_MS = 14 * DAY_MS;

/** Email sends logged as failed (lib/email.ts) in the day before `now`, as a count only. */
async function emailFailureNotices(now: Date): Promise<Notice[]> {
    const failed = await prisma.integrationErrorLog.count({ where: { source: "email", timestamp: { gt: new Date(now.getTime() - DAY_MS), lte: now } } });
    return failed > 0 ? [{ text: `Emails failed to send: ${failed} in the last day`, href: "/system-status/links" }] : [];
}

/**
 * Runs one listed item's step once, through the library the Problems list names it by. A library
 * that is not listed or has no database answers 404; the library's own retry answers the rest.
 */
export async function retryProblem({ library, step, id }: { library: string; step: string; id: string }, by: ProblemRetrier): Promise<void> {
    const source = SOURCES.find((s) => s.library === library && isWired(s));
    if (!source) throw new ServiceError(404, "No such library on the Problems list");
    await source.retry({ id, step }, by);
}

/**
 * Every stuck item across the receipt flow and membership, oldest first, and the count lines (`notices`): the
 * libraries' own and failed email sends. A source whose read fails is named in `unread`.
 */
export async function getProblems(now = new Date()): Promise<{ items: Problem[]; unread: string[]; notices: Notice[] }> {
    const sources = SOURCES.filter(isWired);
    const results = await Promise.allSettled([
        ...sources.map(async (s) => ({
            items: await s.read(),
            notices: s.notices ? await s.notices() : [],
        })),
        emailFailureNotices(now).then((notices) => ({ items: [], notices })),
    ]);
    const items: Problem[] = [];
    const unread: string[] = [];
    const notices: Notice[] = [];
    results.forEach((result, i) => {
        const library = sources[i]?.library ?? "email";
        if (result.status === "fulfilled") {
            items.push(...result.value.items.map((item) => ({ ...item, library })));
            notices.push(...result.value.notices);
        } else {
            logger.error(library === "email" ? "[problems] could not count failed email sends:" : `[problems] could not read the stuck items in ${library}:`, result.reason);
            unread.push(library);
        }
    });
    items.sort((a, b) => a.failedAt.getTime() - b.failedAt.getTime());
    return { items, unread, notices };
}

const address = (value: string | null | undefined): string | null => value?.trim() || null;

/** A job whose latest run reported failures; a late job is listed as late instead. */
export const failingJob = (j: CronJobStatus): j is CronJobStatus & { lastError: string; lastErrorAt: Date } =>
    Boolean(j.lastError && j.lastErrorAt) && !j.stale;

/** The QuickBooks posting warnings in force, whichever of the nightly and posting runs went first; none when they can't be read. */
async function quickBooksPostingLines(): Promise<string[]> {
    try {
        return (await currentPostingWarnings()).map((w) => `QuickBooks posting: ${w.text}`);
    } catch (err) {
        logger.error("[problems] could not read the QuickBooks posting warnings:", err);
        return [];
    }
}

/**
 * The daily email: while anything has been stuck more than a day, a job has not run on time or its
 * latest run reported failures, or a library has a line of its own, the alert address gets the list; the Board address gets a copy once anything has been stuck more than
 * two weeks. Ids, steps and dates only. An unset address sends nothing. Never throws.
 * `tonight` is the calling run's own failures, which its run record does not hold yet.
 *
 * ponytail: it sends on every nightly run, so a same-night rerun of the nightly job sends it twice.
 */
export async function sendProblemsDigest(now = new Date(), tonight: string[] = []): Promise<void> {
    try {
        const [{ items, unread, notices }, jobs, settings, quickBooks] = await Promise.all([
            getProblems(now),
            getCronJobStatuses(),
            prisma.boardSettings.findUnique({ where: { id: 1 }, select: { alertEmailAddress: true, boardEmailAddress: true } }),
            quickBooksPostingLines(),
        ]);
        const age = (at: Date) => now.getTime() - at.getTime();
        const stuck = items.filter((i) => age(i.failedAt) > DAY_MS);
        const stale = jobs.filter((j): j is CronJobStatus & { lastSuccessAt: Date } => j.stale && j.lastSuccessAt !== null);
        const failing = jobs.filter(failingJob);
        if (stuck.length === 0 && stale.length === 0 && failing.length === 0 && unread.length === 0 && notices.length === 0 && tonight.length === 0 && quickBooks.length === 0) return;

        const when = (at: Date) => formatDateTime(at, { timeZone: APP_TIMEZONE, dateStyle: "medium", timeStyle: "short" });
        const lines = [
            ...tonight,
            ...quickBooks,
            ...stuck.map((i) => `${i.library}, ${i.step}: ${i.id}, stuck since ${when(i.failedAt)}`),
            ...stale.map((j) => `Scheduled job ${j.job}: last ran ${when(j.lastSuccessAt)}`),
            ...failing.map((j) => `Scheduled job ${j.job}: last run reported failures, ${when(j.lastErrorAt)}`),
            ...unread.map(unreadLine),
            ...notices.map((n) => n.text),
        ];
        const ctx = { count: String(lines.length), items: lines.join("\n"), actionLink: `${config.baseUrl()}/system-status/health` };

        const alertTo = address(settings?.alertEmailAddress);
        const boardTo = address(settings?.boardEmailAddress);
        const forBoard = stuck.some((i) => age(i.failedAt) > BOARD_AFTER_MS) || stale.some((j) => age(j.lastSuccessAt) > BOARD_AFTER_MS);
        if (alertTo) await sendTemplated("ops.problemsDigest", alertTo, ctx);
        if (boardTo && forBoard) await sendTemplated("ops.problemsDigest", boardTo, ctx);
    } catch (err) {
        logger.error("[problems] daily email failed:", err);
    }
}
