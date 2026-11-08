import type { StuckItem } from "@checkin/component-kit";
import { config } from "@/lib/config";
import { getCronJobStatuses } from "@/lib/cronRuns";
import { sendTemplated } from "@/lib/email-templates/send";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { APP_TIMEZONE, formatDateTime } from "@/lib/time";

/** One stuck item on the Problems list, named by the library that holds it. */
export interface Problem extends StuckItem {
    library: string;
}

/**
 * Each receipt-flow library's "stuck items" port, and its own Problems lines where it has them;
 * one with no database configured is not read.
 */
const SOURCES: { library: string; env: string; read: () => Promise<StuckItem[]>; notices?: () => Promise<string[]> }[] = [
    {
        library: "receipt",
        env: "RECEIPT_DATABASE_URL",
        read: async () => (await import("@checkin/receipt")).stuckItems(),
        notices: async () => (await import("@checkin/receipt")).problemNotices(),
    },
    { library: "workflow mapping", env: "WORKFLOW_MAPPING_DATABASE_URL", read: async () => (await import("@checkin/workflow-mapping")).stuckItems() },
    { library: "expense", env: "EXPENSE_DATABASE_URL", read: async () => (await import("@checkin/expense")).stuckItems() },
    { library: "gifts", env: "BULK_DONATION_DATABASE_URL", read: async () => (await import("@checkin/bulk-donation")).stuckItems() },
    { library: "local inventory", env: "LOCAL_INVENTORY_DATABASE_URL", read: async () => (await import("@checkin/local-inventory")).stuckItems() },
];

/**
 * Every stuck item across the receipt flow, oldest first, and the libraries' own lines
 * (`notices`, counts only). A library whose read fails is named in `unread`.
 */
export async function getProblems(): Promise<{ items: Problem[]; unread: string[]; notices: string[] }> {
    const wired = SOURCES.filter((s) => process.env[s.env]);
    const results = await Promise.allSettled(
        wired.map(async (s) => ({ items: await s.read(), notices: s.notices ? await s.notices() : [] })),
    );
    const items: Problem[] = [];
    const unread: string[] = [];
    const notices: string[] = [];
    results.forEach((result, i) => {
        const { library } = wired[i];
        if (result.status === "fulfilled") {
            items.push(...result.value.items.map((item) => ({ ...item, library })));
            notices.push(...result.value.notices);
        } else {
            logger.error(`[problems] could not read ${library}'s stuck items:`, result.reason);
            unread.push(library);
        }
    });
    items.sort((a, b) => a.failedAt.getTime() - b.failedAt.getTime());
    return { items, unread, notices };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const BOARD_AFTER_MS = 14 * DAY_MS;

const address = (value: string | null | undefined): string | null => value?.trim() || null;

/**
 * The daily email: while anything has been stuck more than a day, a job has not run on time, or a
 * library has a line of its own, the alert address gets the list; the Board address gets a copy once anything has been stuck more than
 * two weeks. Ids, steps and dates only. An unset address sends nothing. Never throws.
 *
 * ponytail: it sends on every nightly run, so a same-night rerun of the nightly job sends it twice.
 */
export async function sendProblemsDigest(now = new Date()): Promise<void> {
    try {
        const [{ items, unread, notices }, jobs, settings] = await Promise.all([
            getProblems(),
            getCronJobStatuses(),
            prisma.boardSettings.findUnique({ where: { id: 1 }, select: { alertEmailAddress: true, boardEmailAddress: true } }),
        ]);
        const age = (at: Date) => now.getTime() - at.getTime();
        const stuck = items.filter((i) => age(i.failedAt) > DAY_MS);
        const stale = jobs.filter((j) => j.stale);
        if (stuck.length === 0 && stale.length === 0 && unread.length === 0 && notices.length === 0) return;

        const when = (at: Date) => formatDateTime(at, { timeZone: APP_TIMEZONE, dateStyle: "medium", timeStyle: "short" });
        const lines = [
            ...stuck.map((i) => `${i.library}, ${i.step}: ${i.id}, stuck since ${when(i.failedAt)}`),
            ...stale.map((j) => `Scheduled job ${j.job}: last ran ${when(j.lastSuccessAt)}`),
            ...unread.map((library) => `${library}: its stuck items could not be read`),
            ...notices,
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
