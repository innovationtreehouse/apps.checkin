import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { config } from "@/lib/config";
import { quickBooks } from "@/lib/components/ports";

// The app's read-only copy of QuickBooks' account and Class lists (docs/rules/revenue.md).
// Pickers and save-time checks read only this copy; posting and System Status read QuickBooks live.

export type SavedAccount = { id: string; name: string; accountType: string; active: boolean };
export type SavedClass = { id: string; name: string; active: boolean };

type ListName = "account" | "class";

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/**
 * Reads both lists from QuickBooks and replaces both rows together; a failed read throws and leaves the old copy as it was.
 * Null while QuickBooks is off, and under CHECKIN_ENV=local, whose pickers read stand-in lists.
 */
export async function refreshQuickBooksLists() {
    const qb = config.quickBooksMockActive() ? null : await quickBooks();
    if (!qb) return null;
    const [accounts, classes] = await Promise.all([qb.accounts(), qb.classes()]);
    const account: SavedAccount[] = accounts
        .map((a) => ({ id: a.Id, name: a.FullyQualifiedName, accountType: a.AccountType ?? "", active: a.Active !== false }))
        .sort(byName);
    const klass: SavedClass[] = classes.map((c) => ({ id: c.Id, name: c.FullyQualifiedName, active: c.Active !== false })).sort(byName);
    const refreshedAt = new Date();
    const write = (list: ListName, entries: Prisma.InputJsonValue) =>
        prisma.quickBooksList.upsert({ where: { list }, create: { list, entries, refreshedAt }, update: { entries, refreshedAt } });
    await prisma.$transaction([write("account", account), write("class", klass)]);
    return { refreshedAt, accounts: account.length, classes: klass.length };
}

async function savedEntries(list: ListName): Promise<Prisma.JsonObject[]> {
    const row = await prisma.quickBooksList.findUnique({ where: { list }, select: { entries: true } });
    const entries = row?.entries;
    if (!Array.isArray(entries)) return [];
    return entries.filter((e): e is Prisma.JsonObject => typeof e === "object" && e !== null && !Array.isArray(e));
}

const isString = (v: unknown): v is string => typeof v === "string";

/** The copy's accounts by full name; empty before the first refresh. */
export async function savedQuickBooksAccounts(): Promise<SavedAccount[]> {
    return (await savedEntries("account")).flatMap((e) =>
        isString(e.id) && isString(e.name) && isString(e.accountType) ? [{ id: e.id, name: e.name, accountType: e.accountType, active: e.active !== false }] : [],
    );
}

/** The copy's Classes by full name; empty before the first refresh. */
export async function savedQuickBooksClasses(): Promise<SavedClass[]> {
    return (await savedEntries("class")).flatMap((e) => (isString(e.id) && isString(e.name) ? [{ id: e.id, name: e.name, active: e.active !== false }] : []));
}

/** When each saved list was last refreshed and how many entries it holds; empty before the first refresh. */
export async function quickBooksListsStatus() {
    const rows = await prisma.quickBooksList.findMany({ select: { list: true, entries: true, refreshedAt: true }, orderBy: { list: "asc" } });
    return rows.map((r) => ({ list: r.list, refreshedAt: r.refreshedAt, entries: Array.isArray(r.entries) ? r.entries.length : 0 }));
}
