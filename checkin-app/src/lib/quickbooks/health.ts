/**
 * QuickBooks rows for the System Status page: the connection, the books closing date, and
 * whether each posting lane is bound. Reads live (token, closing date) only when the page
 * asks, cached briefly, each under a short timeout, so a QuickBooks outage cannot hang it.
 * Never names a realm id, token or secret. Not counted in the nav badge, which stays a
 * presence check with no network read.
 */
import { BOOKS_MAP_ROLES, type BooksMapRole } from "@checkin/quickbooks";
import type { ConfigCheck } from "@/lib/configHealth";
import { tryBuildQuickBooks } from "@/lib/quickbooks/client";

const CACHE_MS = 60_000;
const READ_TIMEOUT_MS = 5_000;

let cached: { at: number; checks: Promise<ConfigCheck[]> } | null = null;

/** The QuickBooks rows, recomputed at most once a minute. */
export function getQuickBooksHealth(now: number = Date.now()): Promise<ConfigCheck[]> {
    if (!cached || now - cached.at >= CACHE_MS) cached = { at: now, checks: computeQuickBooksHealth() };
    return cached.checks;
}

function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not answer within ${READ_TIMEOUT_MS / 1000} seconds`)), READ_TIMEOUT_MS);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** True only where the guard lets a client be built at all; elsewhere QuickBooks is off by design. */
function quickBooksExpectedHere(): boolean {
    return process.env.CHECKIN_ENV === "prod" || process.env.CHECKIN_ENV === "dev";
}

async function connectionChecks(): Promise<ConfigCheck[]> {
    const id = "quickbooks-connection";
    const label = "QuickBooks connection";
    if (!quickBooksExpectedHere()) {
        return [{ id, label, ok: true, detail: "Off on this instance by design (QuickBooks runs only on prod and dev)." }, closingNotRead(true)];
    }
    const built = tryBuildQuickBooks();
    if (!built.ok) return [{ id, label, ok: false, detail: `Off: ${built.reason}.` }, closingNotRead(false)];
    try {
        await withTimeout(built.tokens.current(), "The token refresher");
    } catch (err) {
        return [{ id, label, ok: false, detail: `Off: the token refresher failed (${message(err)}).` }, closingNotRead(false)];
    }
    const company = built.env === "production" ? "production" : "sandbox";
    const closing = await closingDateCheck(() => built.client.bookCloseDate());
    return [{ id, label, ok: true, detail: `Connected to the ${company} company.` }, closing];
}

const CLOSE_ID = "quickbooks-close-date";
const CLOSE_LABEL = "QuickBooks books closing date";

/** The closing date is read only over a working connection; its row follows the connection's. */
function closingNotRead(ok: boolean): ConfigCheck {
    return { id: CLOSE_ID, label: CLOSE_LABEL, ok, detail: "Not read while QuickBooks is off." };
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

function roleName(role: BooksMapRole): string {
    return role.toLowerCase().replace(/_/g, " ");
}

type Lane = {
    id: string;
    label: string;
    missing: () => string[];
    switchedOnAt: (orgId: string) => Promise<Date | null>;
    rolePrefix?: string;
};

async function laneCheck(lane: Lane, orgId: string | null, mapped: Partial<Record<BooksMapRole, string>> | null): Promise<ConfigCheck> {
    const missing = lane.missing();
    const parts = [missing.length === 0 ? "Bound." : `Unbound; missing: ${missing.join(", ")}.`];
    if (orgId) {
        try {
            const at = await withTimeout(lane.switchedOnAt(orgId), "The switch-on read");
            if (at) parts.push(`Posting switched on ${at.toISOString().slice(0, 10)}.`);
        } catch (err) {
            parts.push(`Switch-on date unreadable (${message(err)}).`);
        }
    }
    // ponytail: map roles are information until the lane binds through the map; then they count toward ok.
    const prefix = lane.rolePrefix;
    if (prefix && mapped) {
        const unpicked = BOOKS_MAP_ROLES.filter((r) => r.startsWith(prefix) && !mapped[r]);
        if (unpicked.length) parts.push(`No account picked for: ${unpicked.map(roleName).join(", ")}.`);
    }
    return { id: lane.id, label: lane.label, ok: missing.length === 0, detail: parts.join(" ") };
}

async function laneChecks(): Promise<ConfigCheck[]> {
    const [income, donation, expense, { getOrg }, { booksMap }] = await Promise.all([
        import("@/lib/income/configure"),
        import("@/lib/bulkDonation/configure"),
        import("@/lib/expense/configure"),
        import("@/lib/catalog/configure"),
        import("@/lib/finance/booksMap"),
    ]);
    const lanes: Lane[] = [
        {
            id: "quickbooks-lane-income",
            label: "QuickBooks posting: Shopify income",
            missing: income.incomePostingMissing,
            switchedOnAt: async (orgId) => (await import("@checkin/income")).postingOnAt(orgId),
            rolePrefix: "SHOPIFY_",
        },
        {
            id: "quickbooks-lane-donations",
            label: "QuickBooks posting: Benevity donations",
            missing: donation.donationPostingMissing,
            switchedOnAt: async (orgId) => (await import("@checkin/bulk-donation")).qbPostingOnAt(orgId),
            rolePrefix: "BENEVITY_",
        },
        {
            id: "quickbooks-lane-expenses",
            label: "QuickBooks posting: expenses",
            missing: expense.expensePostingMissing,
            switchedOnAt: async (orgId) => (await import("@checkin/expense")).qbPostingOnAt(orgId),
        },
    ];
    const [orgId, mapped] = await Promise.all([
        getOrg().then((o) => o.id, () => null),
        booksMap.accounts().catch(() => null),
    ]);
    return Promise.all(lanes.map((lane) => laneCheck(lane, orgId, mapped)));
}

async function computeQuickBooksHealth(): Promise<ConfigCheck[]> {
    const [connection, lanes] = await Promise.all([connectionChecks(), laneChecks()]);
    return [...connection, ...lanes];
}
