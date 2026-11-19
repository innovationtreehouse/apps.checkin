import { message, withTimeout, type ConfigCheck } from "@/lib/configHealth";

const id = "quickbooks-pick-types";
const label = "QuickBooks picks: account types";

/**
 * The System Status row for every stored QuickBooks pick outside the books map, checked against the app's
 * copy of QuickBooks' account list. Reads the copy, never QuickBooks.
 */
export async function quickBooksPicksCheck(): Promise<ConfigCheck> {
    try {
        const [{ listQuickBooksAccounts }, expense, donation, income] = await Promise.all([
            import("@/lib/finance/booksMap"),
            import("@checkin/expense"),
            import("@checkin/bulk-donation"),
            import("@checkin/income"),
        ]);
        const accounts = await listQuickBooksAccounts();
        if (accounts.length === 0) return { id, label, ok: true, detail: "Not checked: the QuickBooks lists have not been copied yet." };
        const reads = [expense, donation, income].map((lib) => lib.misTypedQuickBooksPicks(accounts));
        const wrong = (await withTimeout(Promise.all(reads), "The picks check")).flat();
        return wrong.length === 0
            ? { id, label, ok: true, detail: "Every stored pick is of a type it accepts." }
            : { id, label, ok: false, detail: `Re-pick: ${wrong.join("; ")}.` };
    } catch (err) {
        return { id, label, ok: false, detail: `Could not read it: ${message(err)}.` };
    }
}
