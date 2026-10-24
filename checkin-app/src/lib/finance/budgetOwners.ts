import prisma from "@/lib/prisma";
import { badRequest, forbidden, notFound, ApiResponseError } from "@/security/handler";
import { personActor } from "@/lib/auditActor";
import { hasHouseholdConflict } from "@/lib/conflictOfInterest";
import { uniqueViolationFields } from "@/lib/prismaUniqueViolation";
import { LIVE_PERSON } from "@/lib/person/filters";
import { logger } from "@/lib/logger";

// Budget-owner buckets (#1280 §6) and their approvers. FINANCE manages buckets;
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

/** Every QuickBooks Class by its full name, inactive ones flagged, for the bucket form's picker. */
export async function listQuickBooksClasses() {
    const qb = await (await import("@/lib/quickbooks/client")).getQuickBooks();
    if (!qb) throw new ApiResponseError(503, "QuickBooks is not connected.");
    const classes = await qb.classes().catch((error: unknown) => {
        logger.error("QuickBooks Class list failed:", error);
        throw new ApiResponseError(503, "QuickBooks did not return its Classes. Try again shortly.");
    });
    return classes
        .map((c) => ({ id: c.Id, name: c.FullyQualifiedName, active: c.Active !== false }))
        .sort((a, b) => a.name.localeCompare(b.name));
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
    if (body.isOrgLevel !== undefined && typeof body.isOrgLevel !== "boolean") throw badRequest("isOrgLevel must be a boolean");
    const isOrgLevel = body.isOrgLevel === true;
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

// Rename and QuickBooks Class mapping. Whether a bucket is org-level never
// changes: lines already approved by assignment would silently need approvers.
export async function updateBudgetOwner(actorId: number, id: number, body: Record<string, unknown>) {
    const data: { name?: string; quickBooksClassId?: string | null } = {};
    if (body.name !== undefined) data.name = readName(body.name);
    if (body.quickBooksClassId !== undefined) data.quickBooksClassId = readClassId(body.quickBooksClassId);
    if (Object.keys(data).length === 0) throw badRequest("Nothing to change.");

    return prisma.$transaction(async (tx) => {
        const before = await tx.budgetOwner.findUnique({ where: { id }, select: { name: true, quickBooksClassId: true } });
        if (!before) throw notFound("Bucket not found");
        const bucket = await tx.budgetOwner.update({ where: { id }, data, select: BUCKET_SELECT }).catch(rethrowClassTaken);
        await tx.auditLog.create({
            data: { ...personActor(actorId), action: "EDIT", tableName: "BudgetOwner", affectedEntityId: id, oldData: before, newData: data },
        });
        return bucket;
    });
}

// Archive is soft and one-way: library rows reference buckets by id.
export async function archiveBudgetOwner(actorId: number, id: number) {
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

export type ApproverRole = "OWNER" | "TREASURER";

/** A bucket's live owner, then its live treasurers by name. */
export async function listBucketApprovers(budgetOwnerId: number) {
    const bucket = await prisma.budgetOwner.findUnique({
        where: { id: budgetOwnerId },
        select: {
            owner: { select: { id: true, name: true, mergedIntoId: true } },
            treasurers: { select: { person: { select: { id: true, name: true, mergedIntoId: true } } }, orderBy: { person: { name: "asc" } } },
        },
    });
    if (!bucket) throw notFound("Bucket not found");
    type Person = { id: number; name: string; mergedIntoId: number | null };
    const row = (person: Person, role: ApproverRole) => ({ budgetOwnerId, personId: person.id, name: person.name, role });
    const live = (person: Person | null): person is Person => person !== null && person.mergedIntoId === null;
    return [
        ...(live(bucket.owner) ? [row(bucket.owner, "OWNER")] : []),
        ...bucket.treasurers.map((t) => t.person).filter(live).map((p) => row(p, "TREASURER")),
    ];
}

/** Every live person, by name, for the Board's owner and treasurer pickers. */
export async function listApproverOptions() {
    return prisma.person.findMany({ where: LIVE_PERSON, select: { id: true, name: true }, orderBy: { name: "asc" } });
}

/** Refuses a missing or org-level bucket, a missing person, and the actor or their household. */
async function assertMayName(actorId: number, budgetOwnerId: number, personId: number) {
    const bucket = await prisma.budgetOwner.findUnique({ where: { id: budgetOwnerId }, select: { isOrgLevel: true } });
    if (!bucket) throw notFound("Bucket not found");
    if (bucket.isOrgLevel) throw new ApiResponseError(409, "An org-level bucket has no owner or treasurers.");
    const target = await prisma.person.findFirst({ where: { id: personId, ...LIVE_PERSON }, select: { householdId: true } });
    if (!target) throw notFound("Person not found");
    if (actorId === personId || (await hasHouseholdConflict(prisma, actorId, target.householdId))) {
        throw forbidden(OWN_HOUSEHOLD_MESSAGE);
    }
}

/**
 * Sets or clears a bucket's owner. Nobody names, or removes, themself or anyone
 * in their own household, board members included.
 */
export async function setBucketOwner(actorId: number, budgetOwnerId: number, personId: number | null) {
    const before = await prisma.budgetOwner.findUnique({ where: { id: budgetOwnerId }, select: { ownerId: true } });
    if (!before) throw notFound("Bucket not found");
    for (const subject of new Set([personId, before.ownerId])) {
        if (subject !== null) await assertMayName(actorId, budgetOwnerId, subject);
    }
    if (before.ownerId !== personId) {
        await prisma.$transaction(async (tx) => {
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
        });
    }
    return listBucketApprovers(budgetOwnerId);
}

/**
 * Adds or removes a bucket treasurer. Nobody sets or clears it on themself or
 * anyone in their own household, board members included.
 */
export async function setBucketTreasurer(actorId: number, budgetOwnerId: number, personId: number, on: boolean) {
    await assertMayName(actorId, budgetOwnerId, personId);
    const key = { budgetOwnerId_personId: { budgetOwnerId, personId } };
    await prisma.$transaction(async (tx) => {
        const isTreasurer = (await tx.budgetOwnerTreasurer.findUnique({ where: key, select: { personId: true } })) !== null;
        if (isTreasurer === on) return;
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
    });
    return listBucketApprovers(budgetOwnerId);
}
