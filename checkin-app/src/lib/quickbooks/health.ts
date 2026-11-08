/**
 * QuickBooks rows for the System Status page: the connection, the books closing date, the
 * books map's account types, and whether each posting lane is bound. Reads live (token, closing date) only when the page
 * asks, cached briefly, each under a short timeout, so a QuickBooks outage cannot hang it.
 * Never names a realm id, token or secret. Not counted in the nav badge, which stays a
 * presence check with no network read.
 */
import type { QboAccount } from "@checkin/quickbooks";
import { kindOf } from "@checkin/component-kit";
import { message, withTimeout, type ConfigCheck } from "@/lib/configHealth";
import { tryBuildQuickBooks } from "@/lib/quickbooks/client";

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

async function computeQuickBooksHealth(): Promise<ConfigCheck[]> {
    const [connection, lanes] = await Promise.all([connectionChecks(), laneChecks()]);
    return [...connection, ...lanes];
}
