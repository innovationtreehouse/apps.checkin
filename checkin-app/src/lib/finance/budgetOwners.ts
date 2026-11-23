import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { badRequest, forbidden, notFound, ApiResponseError } from "@/security/handler";
import { personActor } from "@/lib/auditActor";
import { hasHouseholdConflict } from "@/lib/conflictOfInterest";
import { uniqueViolationFields } from "@/lib/prismaUniqueViolation";
import { config } from "@/lib/config";
import { savedQuickBooksClasses } from "@/lib/finance/quickBooksLists";
import { IN_LIVE_HOUSEHOLD } from "@/lib/household/archived";
import { lockLiveHouseholdsOf } from "@/lib/household/archiveGuard";
import { ServiceError } from "@checkin/component-kit";
import { emailAfterAssignment, gatePositionCheck, type Position } from "@/lib/membership/positionCheck";
import { QUICKBOOKS_LIST_STALE, UPDATE_NOW_HINT } from "@checkin/quickbooks";

// Budget-owner buckets and their approvers. FINANCE manages buckets;
// the BOARD sets each bucket's owner and treasurers.

const BUCKET_SELECT = {
    id: true,
    name: true,
    isOrgLevel: true,
    archivedAt: true,
    quickBooksClassId: true,
} as const;

export const OWN_HOUSEHOLD_MESSAGE =
    "You can't set a role or flag on yourself or anyone in your own household.";

export async function listBudgetOwners(includeArchived: boolean) {
    return prisma.budgetOwner.findMany({
        where: includeArchived ? {} : { archivedAt: null },
        select: BUCKET_SELECT,
        orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { name: "asc" }],
    });
}

// Stand-in Classes for CHECKIN_ENV=local; ids are digits, as the bucket form requires.
export const LOCAL_QUICKBOOKS_CLASSES = [
    { id: "9001", name: "Facility", active: true },
    { id: "9002", name: "Operations", active: true },
    { id: "9003", name: "Programs:Robotics", active: true },
    { id: "9004", name: "Programs:Woodshop", active: true },
    { id: "9005", name: "Retired", active: false },
    { id: "9006", name: "Woodworking 101", active: true },
];

/** Every Class in the app's QuickBooks list by its full name, inactive ones flagged, for the bucket form's picker. */
export async function listQuickBooksClasses() {
    if (config.quickBooksMockActive()) return LOCAL_QUICKBOOKS_CLASSES.map((c) => ({ ...c }));
    return savedQuickBooksClasses();
}

/**
 * One Class as the save check reads it. The local stand-ins answer active for an id they don't list,
 * because flow tests mint a fresh Class id for each bucket.
 */
export async function findQuickBooksClass(id: string) {
    if (config.quickBooksMockActive()) return LOCAL_QUICKBOOKS_CLASSES.find((c) => c.id === id) ?? { id, name: id, active: true };
    return (await savedQuickBooksClasses()).find((c) => c.id === id);
}

function readName(value: unknown): string {
    if (typeof value !== "string" || !value.trim()) throw badRequest("name is required");
    return value.trim();
}

function readClassId(value: unknown): string | null {
    if (value === null) return null;
    if (typeof value !== "string") throw badRequest("quickBooksClassId must be a string or null");
    const id = value.trim();
    // QuickBooks ref ids are numeric; the expense poster refuses anything else.
    if (id && !/^\d+$/.test(id)) throw badRequest("quickBooksClassId must be a QuickBooks id (digits only)");
    return id || null;
}

/** Refuses a Class the app's copy of QuickBooks' Class list lacks or shows as inactive. */
async function refuseUnusableClass(classId: string) {
    const klass = await findQuickBooksClass(classId);
    if (klass?.active) return;
    const why = klass ? `QuickBooks' list in the app shows ${klass.name} as inactive` : `QuickBooks' list in the app doesn't have a Class with id ${classId}`;
    throw new ApiResponseError(400, `${why}. ${UPDATE_NOW_HINT}`, QUICKBOOKS_LIST_STALE);
}

// A QuickBooks Class maps to one bucket.
function rethrowClassTaken(error: unknown): never {
    if (uniqueViolationFields(error)?.includes("quickBooksClassId")) {
        throw new ApiResponseError(409, "That QuickBooks Class is already mapped to another bucket.");
    }
    throw error;
}

export async function createBudgetOwner(actorId: number, body: Record<string, unknown>) {
    const name = readName(body.name);
    const quickBooksClassId = body.quickBooksClassId === undefined ? null : readClassId(body.quickBooksClassId);
    if (!quickBooksClassId) throw badRequest("A bucket needs a QuickBooks Class.");
    if (body.isOrgLevel !== undefined && typeof body.isOrgLevel !== "boolean") throw badRequest("isOrgLevel must be a boolean");
    const isOrgLevel = body.isOrgLevel === true;
    await refuseUnusableClass(quickBooksClassId);
    return prisma.$transaction(async (tx) => {
        const bucket = await tx.budgetOwner
            .create({ data: { name, isOrgLevel, quickBooksClassId }, select: BUCKET_SELECT })
            .catch(rethrowClassTaken);
        await tx.auditLog.create({
            data: { ...personActor(actorId), action: "CREATE", tableName: "BudgetOwner", affectedEntityId: bucket.id, newData: { name, isOrgLevel, quickBooksClassId } },
        });
        return bucket;
    });
}

// Rename, QuickBooks Class mapping, the org-level flag and restoring an archived bucket.
export async function updateBudgetOwner(actorId: number, id: number, body: Record<string, unknown>) {
    const data: { name?: string; quickBooksClassId?: string | null; isOrgLevel?: boolean; archivedAt?: null } = {};
    if (body.name !== undefined) data.name = readName(body.name);
    if (body.quickBooksClassId !== undefined) data.quickBooksClassId = readClassId(body.quickBooksClassId);
    if (body.isOrgLevel !== undefined) {
        if (typeof body.isOrgLevel !== "boolean") throw badRequest("isOrgLevel must be a boolean");
        data.isOrgLevel = body.isOrgLevel;
    }
    if (body.archived !== undefined) {
        if (body.archived !== false) throw badRequest("archived can only be false: this restores a bucket");
        data.archivedAt = null;
    }
    if (Object.keys(data).length === 0) throw badRequest("Nothing to change.");

    const change = (awaitingBoardSeat: () => Promise<number>) => prisma.$transaction(async (tx) => {
        await lockBucket(tx, id);
        const stored = await tx.budgetOwner.findUnique({
            where: { id },
            select: { name: true, quickBooksClassId: true, isOrgLevel: true, archivedAt: true, ownerId: true, _count: { select: { treasurers: true } } },
        });
        if (!stored) throw notFound("Bucket not found");
        const { ownerId, _count, ...before } = stored;
        // A bucket with no Class keeps saving without one; a bucket with one never loses it.
        if (data.quickBooksClassId === null && before.quickBooksClassId !== null) {
            throw badRequest("A bucket's QuickBooks Class can be changed but not cleared.");
        }
        // A new Class, or the one a restore brings back, must be active; an unchanged Class on a live bucket isn't re-read.
        const classId = data.quickBooksClassId ?? before.quickBooksClassId;
        const classChanged = data.quickBooksClassId != null && data.quickBooksClassId !== before.quickBooksClassId;
        const restoring = data.archivedAt === null && before.archivedAt !== null;
        if (classId && (classChanged || restoring)) await refuseUnusableClass(classId);
        if (data.isOrgLevel === true && !before.isOrgLevel && (ownerId !== null || _count.treasurers > 0)) {
            // Only the Board removes approvers, so finance's change waits for it.
            throw new ApiResponseError(409, "The Board must remove this bucket's owner and treasurers first.");
        }
        if (data.isOrgLevel === false && before.isOrgLevel) {
            // A program bucket's lines take no Board seat, so the change would drop a seat still owed.
            if ((await awaitingBoardSeat()) > 0) {
                throw new ApiResponseError(409, "Open expenses in this bucket still need a Board signature; have them signed or recorded first.");
            }
        }
        const bucket = await tx.budgetOwner.update({ where: { id }, data, select: BUCKET_SELECT }).catch(rethrowClassTaken);
        await tx.auditLog.create({
            data: { ...personActor(actorId), action: "EDIT", tableName: "BudgetOwner", affectedEntityId: id, oldData: before, newData: data },
        });
        return bucket;
    });
    if (data.isOrgLevel === undefined) return change(async () => 0);
    // Lock order: the expense library's bucket line hold, then the BudgetOwner row. No line enters the bucket until this commits.
    const { holdBucketLines } = await import("@checkin/expense");
    return holdBucketLines(id, data.isOrgLevel, change).catch((e: unknown) => {
        if (e instanceof ServiceError) throw new ApiResponseError(e.status, e.message);
        throw e;
    });
}

/** Every kind of unfinished work the libraries still point at bucket `id`; 503 when one can't be read. */
export async function unfinishedBucketUses(id: number) {
    try {
        const libraries = await Promise.all([import("@checkin/expense"), import("@checkin/bulk-donation"), import("@checkin/income")]);
        return (await Promise.all(libraries.map((lib) => lib.unfinishedBucketUses(id)))).flat();
    } catch (err) {
        console.error(`[budget-owners] reading what still uses bucket ${id} failed`, err);
        throw new ApiResponseError(503, "Can't check what still uses this bucket; try again.");
    }
}

// Archive is soft: library rows reference buckets by id, and updateBudgetOwner restores it.
// The library reads run before the commit, across other databases, so a line assigned in between can still land (accepted).
export async function archiveBudgetOwner(actorId: number, id: number) {
    const stored = await prisma.budgetOwner.findUnique({ where: { id }, select: BUCKET_SELECT });
    if (!stored) throw notFound("Bucket not found");
    if (stored.archivedAt) return stored;
    const uses = await unfinishedBucketUses(id);
    if (uses.length > 0) {
        const list = uses.map((u) => `${u.what}: ${u.count} (${u.where})`).join("; ");
        throw new ApiResponseError(409, `This bucket still has unfinished work. Move it to another bucket first: ${list}.`);
    }
    return prisma.$transaction(async (tx) => {
        const before = await tx.budgetOwner.findUnique({ where: { id }, select: { archivedAt: true } });
        if (!before) throw notFound("Bucket not found");
        if (before.archivedAt) return tx.budgetOwner.findUniqueOrThrow({ where: { id }, select: BUCKET_SELECT });
        const bucket = await tx.budgetOwner.update({ where: { id }, data: { archivedAt: new Date() }, select: BUCKET_SELECT });
        await tx.auditLog.create({
            data: { ...personActor(actorId), action: "EDIT", tableName: "BudgetOwner", affectedEntityId: id, oldData: { archivedAt: null }, newData: { archivedAt: bucket.archivedAt } },
        });
        return bucket;
    });
}

const ORG_LEVEL_HAS_NO_APPROVERS = "An org-level bucket has no owner or treasurers.";

/** Locks the bucket row, so a change to its org-level flag and a change to its approvers run one at a time. */
async function lockBucket(tx: Prisma.TransactionClient, budgetOwnerId: number): Promise<{ isOrgLevel: boolean } | undefined> {
    const [bucket] = await tx.$queryRaw<{ isOrgLevel: boolean }[]>`SELECT "isOrgLevel" FROM "BudgetOwner" WHERE id = ${budgetOwnerId} FOR UPDATE`;
    return bucket;
}

/** Locks the bucket and refuses once it is org-level, which it may have become since the caller checked. */
async function lockProgramBucket(tx: Prisma.TransactionClient, budgetOwnerId: number): Promise<void> {
    if ((await lockBucket(tx, budgetOwnerId))?.isOrgLevel) throw new ApiResponseError(409, ORG_LEVEL_HAS_NO_APPROVERS);
}

export type ApproverRole = "OWNER" | "TREASURER";

/** A bucket's owner, then its treasurers by name. */
export async function listBucketApprovers(budgetOwnerId: number) {
    const bucket = await prisma.budgetOwner.findUnique({
        where: { id: budgetOwnerId },
        select: {
            owner: { select: { id: true, name: true } },
            treasurers: { select: { person: { select: { id: true, name: true } } }, orderBy: { person: { name: "asc" } } },
        },
    });
    if (!bucket) throw notFound("Bucket not found");
    type Person = { id: number; name: string };
    const row = (person: Person, role: ApproverRole) => ({ budgetOwnerId, personId: person.id, name: person.name, role });
    return [
        ...(bucket.owner ? [row(bucket.owner, "OWNER")] : []),
        ...bucket.treasurers.map((t) => row(t.person, "TREASURER")),
    ];
}

/** Every person outside an archived household, by name, for the Board's owner and treasurer pickers. */
export async function listApproverOptions() {
    return prisma.person.findMany({ where: IN_LIVE_HOUSEHOLD, select: { id: true, name: true }, orderBy: { name: "asc" } });
}

/** Refuses a missing or org-level bucket, a missing person, and the actor or their household. */
async function assertMayName(actorId: number, budgetOwnerId: number, personId: number) {
    const bucket = await prisma.budgetOwner.findUnique({ where: { id: budgetOwnerId }, select: { isOrgLevel: true } });
    if (!bucket) throw notFound("Bucket not found");
    if (bucket.isOrgLevel) throw new ApiResponseError(409, ORG_LEVEL_HAS_NO_APPROVERS);
    const target = await prisma.person.findFirst({ where: { id: personId }, select: { householdId: true } });
    if (!target) throw notFound("Person not found");
    if (actorId === personId || (await hasHouseholdConflict(prisma, actorId, target.householdId))) {
        throw forbidden(OWN_HOUSEHOLD_MESSAGE);
    }
}

/** Nobody in an archived household is named an approver. */
async function lockLiveOrRefuse(tx: Prisma.TransactionClient, personId: number) {
    try {
        await lockLiveHouseholdsOf(tx, [personId]);
    } catch (e) {
        if (e instanceof ServiceError) throw new ApiResponseError(e.status, e.message);
        throw e;
    }
}

/** Runs the background-check gate for naming `personId`, answering its 409 with the code the picker acknowledges. */
async function gateCheck(tx: Prisma.TransactionClient, personId: number, position: Position, actorId: number, acknowledged: boolean) {
    try {
        return await gatePositionCheck(tx, { personId, position, actorId, acknowledged });
    } catch (e) {
        if (e instanceof ServiceError) throw new ApiResponseError(e.status, e.message, e.code);
        throw e;
    }
}

/**
 * Sets or clears a bucket's owner. Nobody names, or removes, themself or anyone
 * in their own household, board members included. A new owner whose background
 * check isn't current needs `acknowledgeCheck`, and is then emailed.
 */
export async function setBucketOwner(actorId: number, budgetOwnerId: number, personId: number | null, acknowledgeCheck = false) {
    const before = await prisma.budgetOwner.findUnique({ where: { id: budgetOwnerId }, select: { ownerId: true } });
    if (!before) throw notFound("Bucket not found");
    for (const subject of new Set([personId, before.ownerId])) {
        if (subject !== null) await assertMayName(actorId, budgetOwnerId, subject);
    }
    if (before.ownerId !== personId) {
        const ackId = await prisma.$transaction(async (tx) => {
            await lockProgramBucket(tx, budgetOwnerId);
            if (personId !== null) await lockLiveOrRefuse(tx, personId);
            const gated = personId === null ? null : await gateCheck(tx, personId, "BUDGET_OWNER", actorId, acknowledgeCheck);
            await tx.budgetOwner.update({ where: { id: budgetOwnerId }, data: { ownerId: personId } });
            await tx.auditLog.create({
                data: {
                    ...personActor(actorId),
                    action: "EDIT",
                    tableName: "BudgetOwner",
                    affectedEntityId: budgetOwnerId,
                    oldData: { ownerId: before.ownerId },
                    newData: { ownerId: personId },
                },
            });
            return gated;
        });
        if (ackId !== null) await emailAfterAssignment([ackId], actorId);
    }
    return listBucketApprovers(budgetOwnerId);
}

/**
 * Adds or removes a bucket treasurer. Nobody sets or clears it on themself or
 * anyone in their own household, board members included. A new treasurer whose
 * background check isn't current needs `acknowledgeCheck`, and is then emailed.
 */
export async function setBucketTreasurer(actorId: number, budgetOwnerId: number, personId: number, on: boolean, acknowledgeCheck = false) {
    await assertMayName(actorId, budgetOwnerId, personId);
    const key = { budgetOwnerId_personId: { budgetOwnerId, personId } };
    const ackId = await prisma.$transaction(async (tx) => {
        await lockProgramBucket(tx, budgetOwnerId);
        const isTreasurer = (await tx.budgetOwnerTreasurer.findUnique({ where: key, select: { personId: true } })) !== null;
        if (isTreasurer === on) return null;
        if (on) await lockLiveOrRefuse(tx, personId);
        const gated = on ? await gateCheck(tx, personId, "BUDGET_TREASURER", actorId, acknowledgeCheck) : null;
        if (on) await tx.budgetOwnerTreasurer.create({ data: { budgetOwnerId, personId } });
        else await tx.budgetOwnerTreasurer.delete({ where: key });
        await tx.auditLog.create({
            data: {
                ...personActor(actorId),
                action: on ? "CREATE" : "DELETE",
                tableName: "BudgetOwnerTreasurer",
                affectedEntityId: personId,
                secondaryAffectedEntity: budgetOwnerId,
                newData: { budgetOwnerId, personId, isTreasurer: on },
            },
        });
        return gated;
    });
    if (ackId !== null) await emailAfterAssignment([ackId], actorId);
    return listBucketApprovers(budgetOwnerId);
}
