/**
 * QuickBooks rows for the System Status page: the connection, the books closing date, the account
 * types of the books map and of every other stored pick, the age of the app's copy of QuickBooks' lists, the buckets' Classes, whether each posting lane is bound, and the posting slot: who holds it, the queue, each lane's last run, the throttle pause and today's request count. Reads live (token, closing date) only when the page
 * asks, cached briefly, each under a short timeout, so a QuickBooks outage cannot hang it.
 * Never names a realm id, token or secret. Not counted in the nav badge, which stays a
 * presence check with no network read.
 */
import type { QboAccount } from "@checkin/quickbooks";
import { kindOf } from "@checkin/component-kit";
import { message, withTimeout, type ConfigCheck } from "@/lib/configHealth";
import { tryBuildQuickBooks } from "@/lib/quickbooks/client";
import { quickBooksPicksCheck } from "@/lib/quickbooks/picksHealth";
import { bucketClassesCheck } from "@/lib/finance/bucketClassCheck";
import type { LastRun, PostingLane } from "@/lib/finance/postingRuns";
import type { PostingSlotStatus } from "@/lib/finance/quickBooksPosting";
import { formatDateTime } from "@/lib/time";

const CACHE_MS = 60_000;

let cached: { at: number; checks: Promise<ConfigCheck[]> } | null = null;

/** The QuickBooks rows, recomputed at most once a minute. */
export function getQuickBooksHealth(now: number = Date.now()): Promise<ConfigCheck[]> {
    if (!cached || now - cached.at >= CACHE_MS) cached = { at: now, checks: computeQuickBooksHealth() };
    return cached.checks;
}


/** True only where the guard lets a client be built at all; elsewhere QuickBooks is off by design. */
function quickBooksExpectedHere(): boolean {
    return process.env.CHECKIN_ENV === "prod" || process.env.CHECKIN_ENV === "dev";
}

async function connectionChecks(): Promise<ConfigCheck[]> {
    const id = "quickbooks-connection";
    const label = "QuickBooks connection";
    if (!quickBooksExpectedHere()) {
        return [{ id, label, ok: true, detail: "Off on this instance by design (QuickBooks runs only on prod and dev)." }, ...notRead(true)];
    }
    const built = tryBuildQuickBooks();
    if (!built.ok) return [{ id, label, ok: false, detail: `Off: ${built.reason}.` }, ...notRead(false)];
    try {
        await withTimeout(built.tokens.current(), "The token refresher");
    } catch (err) {
        const kind = kindOf(err);
        const detail = kind === "connection" || kind === "settings" ? message(err) : `Off: the token refresher failed (${message(err)}).`;
        return [{ id, label, ok: false, detail }, ...notRead(false)];
    }
    const company = built.env === "production" ? "production" : "sandbox";
    const [closing, types] = await Promise.all([
        closingDateCheck(() => built.client.bookCloseDate()),
        accountTypesCheck(() => built.client.accounts()),
    ]);
    return [{ id, label, ok: true, detail: `Connected to the ${company} company.` }, closing, types];
}

const CLOSE_ID = "quickbooks-close-date";
const CLOSE_LABEL = "QuickBooks books closing date";

const TYPES_ID = "quickbooks-account-types";
const TYPES_LABEL = "QuickBooks books map: account types";

/** These rows are read only over a working connection; they follow the connection's. */
function notRead(ok: boolean): ConfigCheck[] {
    const detail = "Not read while QuickBooks is off.";
    return [{ id: CLOSE_ID, label: CLOSE_LABEL, ok, detail }, { id: TYPES_ID, label: TYPES_LABEL, ok, detail }];
}

async function accountTypesCheck(read: () => Promise<QboAccount[]>): Promise<ConfigCheck> {
    const id = TYPES_ID;
    const label = TYPES_LABEL;
    try {
        const accounts = await withTimeout(read(), "QuickBooks");
        const wrong = await (await import("@/lib/finance/booksMap")).misTypedRoleAccounts(accounts);
        return wrong.length === 0
            ? { id, label, ok: true, detail: "Every account picked is of a type its role accepts." }
            : { id, label, ok: false, detail: `Re-pick on the books map: ${wrong.join("; ")}.` };
    } catch (err) {
        return { id, label, ok: false, detail: `Could not read it: ${message(err)}.` };
    }
}

async function closingDateCheck(read: () => Promise<string | null>): Promise<ConfigCheck> {
    const id = CLOSE_ID;
    const label = CLOSE_LABEL;
    try {
        const date = await withTimeout(read(), "QuickBooks");
        return { id, label, ok: true, detail: date ? `Books closed through ${date}.` : "None set." };
    } catch (err) {
        return { id, label, ok: false, detail: `Could not read it: ${message(err)}.` };
    }
}

const LISTS_ID = "quickbooks-lists";
const LISTS_LABEL = "QuickBooks lists";
const LISTS_STALE_MS = 2 * 24 * 60 * 60 * 1000;

/** The age of the app's copy of the account and Class lists, read from the copy, so it answers during an outage. */
async function listsCheck(): Promise<ConfigCheck> {
    const id = LISTS_ID;
    const label = LISTS_LABEL;
    if (!quickBooksExpectedHere()) return { id, label, ok: true, detail: "Not copied on this instance by design; its pickers use stand-in lists." };
    try {
        const lists = await withTimeout((await import("@/lib/finance/quickBooksLists")).quickBooksListsStatus(), "The saved lists read");
        if (lists.length < 2) return { id, label, ok: false, detail: "Not copied yet. The daily posting run copies them, or press Update now on the Books map." };
        const oldest = Math.min(...lists.map((l) => l.refreshedAt.getTime()));
        const when = `${new Date(oldest).toISOString().slice(0, 16).replace("T", " ")} UTC`;
        return Date.now() - oldest > LISTS_STALE_MS
            ? { id, label, ok: false, detail: `Refreshed ${when}, more than two days ago. Press Update now on the Books map.` }
            : { id, label, ok: true, detail: `Refreshed ${when}.` };
    } catch (err) {
        return { id, label, ok: false, detail: `Could not read it: ${message(err)}.` };
    }
}

type Lane = {
    id: string;
    label: string;
    missing: () => string[] | Promise<string[]>;
    switchedOnAt: (orgId: string) => Promise<Date | null>;
};

async function laneCheck(lane: Lane, orgId: string | null): Promise<ConfigCheck> {
    let missing: string[];
    try {
        missing = await withTimeout(Promise.resolve(lane.missing()), "The binding check");
    } catch (err) {
        missing = [`a readable binding (${message(err)})`];
    }
    const parts = [missing.length === 0 ? "Bound." : `Unbound; missing: ${missing.join(", ")}.`];
    if (orgId) {
        try {
            const at = await withTimeout(lane.switchedOnAt(orgId), "The switch-on read");
            if (at) parts.push(`Posting switched on ${at.toISOString().slice(0, 10)}.`);
        } catch (err) {
            parts.push(`Switch-on date unreadable (${message(err)}).`);
        }
    }
    return { id: lane.id, label: lane.label, ok: missing.length === 0, detail: parts.join(" ") };
}

async function laneChecks(): Promise<ConfigCheck[]> {
    const [income, donation, expense, { getOrg }] = await Promise.all([
        import("@/lib/income/configure"),
        import("@/lib/bulkDonation/configure"),
        import("@/lib/expense/configure"),
        import("@/lib/components/host"),
    ]);
    const lanes: Lane[] = [
        {
            id: "quickbooks-lane-income",
            label: "QuickBooks posting: Shopify income",
            missing: income.incomePostingMissing,
            switchedOnAt: async (orgId) => (await (await import("@checkin/income")).postingOnAt(orgId)).shopify,
        },
        {
            id: "quickbooks-lane-donations",
            label: "QuickBooks posting: Benevity donations",
            missing: income.benevityPostingMissing,
            // Income books Benevity deposits, so the lane's switch-on is income's Benevity stamp.
            switchedOnAt: async (orgId) => (await (await import("@checkin/income")).postingOnAt(orgId)).benevity,
        },
        {
            id: "quickbooks-lane-in-kind",
            label: "QuickBooks posting: gifts of goods",
            missing: donation.inKindPostingMissing,
            switchedOnAt: async (orgId) => (await import("@checkin/bulk-donation")).inKindPostingOnAt(orgId),
        },
        {
            id: "quickbooks-lane-expenses",
            label: "QuickBooks posting: expenses",
            missing: expense.expensePostingMissing,
            switchedOnAt: async (orgId) => (await import("@checkin/expense")).qbPostingOnAt(orgId),
        },
    ];
    const orgId = await getOrg().then((o) => o.id, () => null);
    return Promise.all(lanes.map((lane) => laneCheck(lane, orgId)));
}

const LANES: PostingLane[] = ["expense", "in-kind", "income"];
const LANE_LABEL: Record<PostingLane, string> = { expense: "expenses", "in-kind": "gifts of goods", income: "income" };
const CAP_LABEL: Record<NonNullable<LastRun["capped"]>, string> = { count: "the per-run limit", day: "the daily limit", cents: "the per-run amount limit" };
const ENDED_LABEL: Record<LastRun["ended"], string> = { done: "finished", yielded: "yielded to a QuickBooks throttle", crashed: "failed", expired: "lapsed without releasing the slot" };
/** The posting slot's rows, from its status, with times in `timeZone`. A lane's last-run row is red while it carries a warning. */
export function postingRows(s: PostingSlotStatus, timeZone: string): ConfigCheck[] {
    const when = (d: Date | string) => formatDateTime(d, { timeZone, dateStyle: "medium", timeStyle: "short" });
    const queued = s.waiting.map((w) => `${LANE_LABEL[w.lane]} (asked by ${w.requestedById === null ? "the daily run" : `person ${w.requestedById}`}, ${when(w.requestedAt)})`);
    const stranded = s.heldBy === null && queued.length > 0;
    const warnings = new Map(s.warnings.map((w) => [w.lane, w.text]));
    const runs = LANES.flatMap((l): ConfigCheck[] => {
        const run = s.lastRuns[l];
        if (!run) return [];
        const cap = run.capped ? `; stopped by ${CAP_LABEL[run.capped]}` : "";
        const summary = `Ended ${when(run.endedAt)}: ${ENDED_LABEL[run.ended]}; created ${run.created}, matched ${run.matched}${cap}.`;
        const warning = warnings.get(l);
        return [{ id: `quickbooks-posting-run-${l}`, label: `QuickBooks posting: last ${LANE_LABEL[l]} run`, ok: !warning, detail: warning ? `${warning} ${summary}` : summary }];
    });
    return [
        {
            id: "quickbooks-posting-slot",
            label: "QuickBooks posting slot",
            ok: true,
            detail: s.heldBy && s.until ? `Held by the ${LANE_LABEL[s.heldBy]} run until ${when(s.until)}.` : "Free.",
        },
        {
            id: "quickbooks-posting-queue",
            label: "QuickBooks posting queue",
            ok: !stranded,
            detail: queued.length === 0
                ? "Empty."
                : stranded
                  ? `Stranded: the last run stopped without finishing, and ${queued.join("; ")} wait. Finance's Catch up restarts them, or they run with tonight's posting.`
                  : `Waiting: ${queued.join("; ")}.`,
        },
        ...runs,
        {
            id: "quickbooks-posting-pause",
            label: "QuickBooks throttle pause",
            ok: true,
            detail: s.pausedUntil ? `QuickBooks asked us to slow down; requests resume at ${when(s.pausedUntil)}.` : "None in force.",
        },
        {
            id: "quickbooks-posting-requests",
            label: "QuickBooks requests today",
            ok: true,
            // ponytail: this server process's count; the monthly allowance (Builder tier, 500,000 calls) is watched by hand.
            detail: `${s.requestsToday} today (UTC) from this server. Intuit's Builder tier allows 500,000 a month.`,
        },
    ];
}

async function postingChecks(): Promise<ConfigCheck[]> {
    try {
        const [{ postingSlotStatus }, { resolveDisplayTimezone }] = await Promise.all([import("@/lib/finance/quickBooksPosting"), import("@/lib/appSettings")]);
        const [status, timeZone] = await Promise.all([withTimeout(postingSlotStatus(), "The posting slot read"), resolveDisplayTimezone()]);
        return postingRows(status, timeZone);
    } catch (err) {
        return [{ id: "quickbooks-posting-slot", label: "QuickBooks posting slot", ok: false, detail: `Could not read it: ${message(err)}.` }];
    }
}

async function computeQuickBooksHealth(): Promise<ConfigCheck[]> {
    const [connection, lists, picks, buckets, lanes, posting] = await Promise.all([connectionChecks(), listsCheck(), quickBooksPicksCheck(), bucketClassesCheck(), laneChecks(), postingChecks()]);
    return [...connection, lists, picks, buckets, ...lanes, ...posting];
}
