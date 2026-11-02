import prisma from "@/lib/prisma";
import { badRequest, ApiResponseError } from "@/security/handler";
import { personActor } from "@/lib/auditActor";
import { logger } from "@/lib/logger";
import { config } from "@/lib/config";
import { quickBooks } from "@/lib/components/ports";
import { updateBudgetOwner } from "@/lib/finance/budgetOwners";
import { BOOKS_MAP_ROLES, isBooksMapRole, type BooksMap, type BooksMapRole } from "@checkin/quickbooks";

// The books map (docs/ops/quickbooks-go-live.md): bucket -> QuickBooks Class,
// stored on BudgetOwner, and named role -> QuickBooks account, stored in
// BooksMapRoleAccount. FINANCE or BOARD reads it; FINANCE edits it, audited.

/** Every live bucket with its Class, and every role with its account (null while unset). */
export async function listBooksMap() {
    const [buckets, rows] = await Promise.all([
        prisma.budgetOwner.findMany({
            where: { archivedAt: null },
            select: { id: true, name: true, quickBooksClassId: true },
            orderBy: { name: "asc" },
        }),
        prisma.booksMapRoleAccount.findMany({ select: { role: true, quickBooksAccountId: true } }),
    ]);
    const set = new Map(rows.map((r) => [r.role, r.quickBooksAccountId]));
    return {
        BooksMapClass: buckets.map((b) => ({ budgetOwnerId: b.id, budgetOwnerName: b.name, quickBooksClassId: b.quickBooksClassId })),
        BooksMapAccount: BOOKS_MAP_ROLES.map((role) => ({ role, quickBooksAccountId: set.get(role) ?? null })),
    };
}

function readQuickBooksId(value: unknown, field: string): string | null {
    if (value === null) return null;
    if (typeof value !== "string") throw badRequest(`${field} must be a string or null`);
    const id = value.trim();
    // QuickBooks ref ids are numeric; the posters refuse anything else.
    if (id && !/^\d+$/.test(id)) throw badRequest(`${field} must be a QuickBooks id (digits only)`);
    return id || null;
}

/** Sets or clears one bucket's Class, audited on the bucket. */
export async function setBooksMapClass(actorId: number, budgetOwnerId: number, body: Record<string, unknown>) {
    if (body.quickBooksClassId === undefined) throw badRequest("quickBooksClassId is required");
    const bucket = await updateBudgetOwner(actorId, budgetOwnerId, { quickBooksClassId: body.quickBooksClassId });
    return { budgetOwnerId: bucket.id, budgetOwnerName: bucket.name, quickBooksClassId: bucket.quickBooksClassId };
}

/** Sets or clears one role's account, audited with the old and new id. */
export async function setBooksMapAccount(actorId: number, role: string, body: Record<string, unknown>) {
    if (!isBooksMapRole(role)) throw badRequest(`Unknown books-map role "${role}"`);
    if (body.quickBooksAccountId === undefined) throw badRequest("quickBooksAccountId is required");
    const quickBooksAccountId = readQuickBooksId(body.quickBooksAccountId, "quickBooksAccountId");
    return prisma.$transaction(async (tx) => {
        const before = await tx.booksMapRoleAccount.findUnique({ where: { role }, select: { quickBooksAccountId: true } });
        const oldId = before?.quickBooksAccountId ?? null;
        if (oldId === quickBooksAccountId) return { role, quickBooksAccountId };
        if (quickBooksAccountId === null) {
            // A concurrent clear may have removed the row first; the loser writes nothing.
            const { count } = await tx.booksMapRoleAccount.deleteMany({ where: { role } });
            if (count === 0) return { role, quickBooksAccountId };
        } else await tx.booksMapRoleAccount.upsert({ where: { role }, create: { role, quickBooksAccountId }, update: { quickBooksAccountId } });
        await tx.auditLog.create({
            data: {
                ...personActor(actorId),
                action: before ? (quickBooksAccountId === null ? "DELETE" : "EDIT") : "CREATE",
                tableName: "BooksMapRoleAccount",
                // The row's key is its role, a string; the role is in oldData and newData.
                affectedEntityId: 0,
                oldData: { role, quickBooksAccountId: oldId },
                newData: { role, quickBooksAccountId },
            },
        });
        return { role, quickBooksAccountId };
    });
}

// Stand-in accounts for CHECKIN_ENV=local; ids are digits, as the role form requires.
export const LOCAL_QUICKBOOKS_ACCOUNTS = [
    { id: "8001", name: "Checking", accountType: "Bank", active: true },
    { id: "8002", name: "Sales:Shop sales", accountType: "Income", active: true },
    { id: "8003", name: "Donations:Benevity", accountType: "Income", active: true },
    { id: "8004", name: "Merchant fees", accountType: "Expense", active: true },
    { id: "8005", name: "Old savings", accountType: "Bank", active: false },
];

/** Every QuickBooks account by its full name, inactive ones flagged, for the role picker. */
export async function listQuickBooksAccounts() {
    if (config.quickBooksMockActive()) return LOCAL_QUICKBOOKS_ACCOUNTS.map((a) => ({ ...a }));
    const qb = await quickBooks();
    if (!qb) throw new ApiResponseError(503, "QuickBooks is not connected.");
    const accounts = await qb.accounts().catch((error: unknown) => {
        logger.error("QuickBooks account list failed:", error);
        throw new ApiResponseError(503, "QuickBooks did not return its accounts. Try again shortly.");
    });
    return accounts
        .map((a) => ({ id: a.Id, name: a.FullyQualifiedName, accountType: a.AccountType ?? "", active: a.Active !== false }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** The host's books-map port: what the income, gifts-of-goods and expense lanes read. */
export const booksMap: BooksMap = {
    async accounts() {
        const rows = await prisma.booksMapRoleAccount.findMany({ select: { role: true, quickBooksAccountId: true } });
        const out: Partial<Record<BooksMapRole, string>> = {};
        for (const r of rows) if (isBooksMapRole(r.role)) out[r.role] = r.quickBooksAccountId;
        return out;
    },
    async classes() {
        const rows = await prisma.budgetOwner.findMany({
            where: { quickBooksClassId: { not: null } },
            select: { id: true, quickBooksClassId: true },
        });
        return new Map(rows.flatMap((r) => (r.quickBooksClassId ? [[r.id, r.quickBooksClassId] as const] : [])));
    },
};
