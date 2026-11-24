import { ServiceError, type StuckItem } from "@checkin/component-kit";
import { personActor, recordAudit } from "@/lib/auditActor";
import { config } from "@/lib/config";
import { getCronJobStatuses, type CronJobStatus } from "@/lib/cronRuns";
import { sendTemplated } from "@/lib/email-templates/send";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { unreadLine } from "@/lib/problemsLines";
import { currentPostingWarnings } from "@/lib/finance/postingRuns";
import { checkEmailStuckItems, retryCheckEmail } from "@/lib/membership/positionCheck";
import { APP_TIMEZONE, formatDate, formatDateTime } from "@/lib/time";

/** The name the Problems list gives the receipt library's items. */
export const RECEIPT_LIBRARY = "receipt";

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
        library: RECEIPT_LIBRARY,
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
        read: async () => [
            ...(await (await import("@/lib/membership/settleHouseholdBg")).stuckSettles()),
            ...(await (await import("@/lib/membership/clearanceSteps")).stuckClearanceSteps()),
        ],
        retry: async (item) => {
            const steps = await import("@/lib/membership/clearanceSteps");
            if (steps.isClearanceStepName(item.step)) return steps.retryClearanceStep(item);
            return (await import("@/lib/membership/settleHouseholdBg")).retryStuckSettle(item);
        },
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

/** How long the Shopify store copy may go without a completed scheduled read before it is listed. */
export const SHOPIFY_READ_STALE_AFTER_MS = 26 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** The Shopify reader's line: its latest scheduled read failed, or none has completed recently or ever. */
async function shopifyReaderNotices(now: Date): Promise<Notice[]> {
    const { scheduledReadState } = await import("@/lib/shopifyRead/client");
    const state = await scheduledReadState();
    if (!state) return [];
    const line = (text: string): Notice[] => [{ text, href: "/finance-ops/payments" }];
    const { latestStatus, lastCompletedAt } = state;
    if (latestStatus === "FAILED" || latestStatus === "ABANDONED") return line(`Shopify read failed: ${latestStatus.toLowerCase()}`);
    if (!lastCompletedAt) return line("Shopify store copy has never been read");
    const age = now.getTime() - lastCompletedAt.getTime();
    return age > SHOPIFY_READ_STALE_AFTER_MS ? line(`Shopify store copy is ${Math.floor(age / HOUR_MS)} hours old`) : [];
}

/** Above this many unpaid payouts, the Problems list gives one count line instead of one line each. */
export const UNPAID_PAYOUT_LINES_MAX = 5;

/** A line for each payout the Shopify reader no longer re-reads that is still not paid. */
async function unpaidPayoutNotices(now: Date): Promise<Notice[]> {
    const { unpaidPayoutsPastRereadWindow, PAYOUT_REREAD_WINDOW_DAYS } = await import("@/lib/shopifyRead/client");
    const payouts = await unpaidPayoutsPastRereadWindow(now);
    const day = (at: Date) => formatDate(at, { timeZone: APP_TIMEZONE, dateStyle: "medium" });
    const after = `after ${PAYOUT_REREAD_WINDOW_DAYS} days`;
    const line = (text: string): Notice => ({ text, href: "/income/payouts" });
    if (payouts.length > UNPAID_PAYOUT_LINES_MAX) {
        return [line(`${payouts.length} Shopify payouts still not paid ${after}, oldest ${day(payouts[0].issuedAt)}`)];
    }
    return payouts.map((p) => {
        const status = p.status ? `still ${p.status.toLowerCase().replaceAll("_", " ")}` : "still with no status";
        return line(`Shopify payout of ${day(p.issuedAt)} ${status} ${after}`);
    });
}

/** The count lines read outside the libraries, each named by `library` in `unread` when its read fails. */
const COUNT_SOURCES: { library: string; notices: (now: Date) => Promise<Notice[]> }[] = [
    { library: "email", notices: emailFailureNotices },
    { library: "Shopify reader", notices: shopifyReaderNotices },
    { library: "Shopify payouts", notices: unpaidPayoutNotices },
];

/**
 * Runs one listed item's step once, through the library the Problems list names it by. A library
 * that is not listed or has no database answers 404; the library's own retry answers the rest.
 */
export async function retryProblem({ library, step, id }: { library: string; step: string; id: string }, by: ProblemRetrier): Promise<void> {
    const source = SOURCES.find((s) => s.library === library && isWired(s));
    if (!source) throw new ServiceError(404, "No such library on the Problems list");
    await source.retry({ id, step }, by);
}

/** The person who pressed Dismiss. */
type ProblemDismisser = { userId: number };

/**
 * Takes one listed item off the Problems list until it fails again: the dismissal is kept against the item's
 * current `failedAt`, with its PROBLEM_DISMISS audit row in the same transaction. An item not listed now,
 * already dismissed included, answers 404.
 */
export async function dismissProblem({ library, step, id }: { library: string; step: string; id: string }, by: ProblemDismisser): Promise<void> {
    const source = SOURCES.find((s) => s.library === library && isWired(s));
    if (!source) throw new ServiceError(404, "No such library on the Problems list");
    const [item] = await withoutDismissed((await source.read()).filter((i) => i.step === step && i.id === id).map((i) => ({ ...i, library })));
    if (!item) throw new ServiceError(404, "No such item on the Problems list");
    await prisma.$transaction(async (tx) => {
        const { count } = await tx.problemDismissal.createMany({
            data: [{ library, step, itemId: id, failedAt: item.failedAt, dismissedById: by.userId }],
            skipDuplicates: true,
        });
        // A concurrent press dismissed it first, and wrote the audit row.
        if (count === 0) throw new ServiceError(404, "No such item on the Problems list");
        await recordAudit(tx, personActor(by.userId), {
            action: "CREATE",
            tableName: "PROBLEM_DISMISS",
            affectedEntityId: 0,
            newData: { library, step, id },
        });
    });
}

/** What a dismissal is keyed by: the item's library, step and id, and the `failedAt` it was listed with. */
export type DismissalKey = Pick<Problem, "library" | "step" | "id" | "failedAt">;

/** The items no person has dismissed at their current `failedAt`, in order. */
export async function withoutDismissed<T extends DismissalKey>(items: T[]): Promise<T[]> {
    if (items.length === 0) return items;
    const dismissed = await prisma.problemDismissal.findMany({
        where: { OR: items.map((i) => ({ library: i.library, step: i.step, itemId: i.id, failedAt: i.failedAt })) },
        select: { library: true, step: true, itemId: true, failedAt: true },
    });
    const key = (library: string, step: string, id: string, failedAt: Date) => JSON.stringify([library, step, id, failedAt.getTime()]);
    const hidden = new Set(dismissed.map((d) => key(d.library, d.step, d.itemId, d.failedAt)));
    return items.filter((i) => !hidden.has(key(i.library, i.step, i.id, i.failedAt)));
}

/**
 * Every stuck item across the receipt flow and membership that no person has dismissed, oldest first, and the
 * count lines (`notices`): the libraries' own, failed email sends, the Shopify reader's, and unpaid Shopify payouts. A source whose read fails is named in `unread`.
 */
export async function getProblems(now = new Date()): Promise<{ items: Problem[]; unread: string[]; notices: Notice[] }> {
    const sources = SOURCES.filter(isWired);
    const results = await Promise.allSettled([
        ...sources.map(async (s) => ({
            items: await s.read(),
            notices: s.notices ? await s.notices() : [],
        })),
        ...COUNT_SOURCES.map(async (c) => ({ items: [], notices: await c.notices(now) })),
    ]);
    const items: Problem[] = [];
    const unread: string[] = [];
    const notices: Notice[] = [];
    results.forEach((result, i) => {
        const library = i < sources.length ? sources[i].library : COUNT_SOURCES[i - sources.length].library;
        if (result.status === "fulfilled") {
            items.push(...result.value.items.map((item) => ({ ...item, library })));
            notices.push(...result.value.notices);
        } else {
            logger.error(i < sources.length ? `[problems] could not read the stuck items in ${library}:` : `[problems] could not read the ${library} line:`, result.reason);
            unread.push(library);
        }
    });
    const listed = await withoutDismissed(items);
    listed.sort((a, b) => a.failedAt.getTime() - b.failedAt.getTime());
    return { items: listed, unread, notices };
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
