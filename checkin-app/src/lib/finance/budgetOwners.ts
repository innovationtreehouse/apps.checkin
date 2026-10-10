import prisma from "@/lib/prisma";
import { badRequest, forbidden, notFound, ApiResponseError } from "@/security/handler";
import { personActor } from "@/lib/auditActor";
import { hasHouseholdConflict } from "@/lib/conflictOfInterest";
import { uniqueViolationFields } from "@/lib/prismaUniqueViolation";
import { LIVE_PERSON } from "@/lib/person/filters";

// Budget-owner buckets (#1280 §6) and program treasurers. FINANCE manages
// buckets; the BOARD sets treasurers. Approvers are derived, never stored: a
// program bucket's are the program's leader plus its treasurers.

const BUCKET_SELECT = {
    id: true,
    name: true,
    programId: true,
    archivedAt: true,
    quickBooksClassId: true,
    program: { select: { id: true, name: true } },
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

export async function listProgramOptions() {
    return prisma.program.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
}

function readName(value: unknown): string {
    if (typeof value !== "string" || !value.trim()) throw badRequest("name is required");
    return value.trim();
}

function readClassId(value: unknown): string | null {
    if (value === null) return null;
    if (typeof value !== "string") throw badRequest("quickBooksClassId must be a string or null");
    return value.trim() || null;
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
    let programId: number | null = null;
    if (body.programId !== undefined && body.programId !== null) {
        if (typeof body.programId !== "number" || !Number.isInteger(body.programId)) {
            throw badRequest("programId must be an integer or null");
        }
        programId = body.programId;
        if (!(await prisma.program.findUnique({ where: { id: programId }, select: { id: true } }))) {
            throw badRequest("Program not found");
        }
    }
    return prisma.$transaction(async (tx) => {
        const bucket = await tx.budgetOwner
            .create({ data: { name, programId, quickBooksClassId }, select: BUCKET_SELECT })
            .catch(rethrowClassTaken);
        await tx.auditLog.create({
            data: { ...personActor(actorId), action: "CREATE", tableName: "BudgetOwner", affectedEntityId: bucket.id, newData: { name, programId, quickBooksClassId } },
        });
        return bucket;
    });
}

// Rename and QuickBooks Class mapping. A bucket's program never changes: library
// rows already booked against it would silently move programs.
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

export async function listProgramTreasurers(programId: number) {
    if (!(await prisma.program.findUnique({ where: { id: programId }, select: { id: true } }))) {
        throw notFound("Program not found");
    }
    return prisma.programVolunteer.findMany({
        where: { programId, person: LIVE_PERSON },
        select: { programId: true, personId: true, isTreasurer: true, person: { select: { id: true, name: true } } },
        orderBy: { person: { name: "asc" } },
    });
}

/**
 * Sets or clears a program volunteer's treasurer flag. Nobody sets a role or flag
 * on themself or anyone in their own household, board members included.
 */
export async function setProgramTreasurer(actorId: number, programId: number, personId: number, on: boolean) {
    const target = await prisma.person.findUnique({ where: { id: personId }, select: { householdId: true } });
    if (!target) throw notFound("Person not found");
    if (actorId === personId || (await hasHouseholdConflict(prisma, actorId, target.householdId))) {
        throw forbidden(OWN_HOUSEHOLD_MESSAGE);
    }
    return prisma.$transaction(async (tx) => {
        const key = { programId_personId: { programId, personId } };
        const select = { programId: true, personId: true, isTreasurer: true } as const;
        const row = await tx.programVolunteer.findUnique({ where: key, select });
        if (!row) throw notFound("That person is not a volunteer on this program.");
        if (row.isTreasurer === on) return row;
        const updated = await tx.programVolunteer.update({ where: key, data: { isTreasurer: on }, select });
        await tx.auditLog.create({
            data: {
                ...personActor(actorId),
                action: "EDIT",
                tableName: "ProgramVolunteer",
                affectedEntityId: personId,
                secondaryAffectedEntity: programId,
                oldData: { isTreasurer: row.isTreasurer },
                newData: { isTreasurer: on },
            },
        });
        return updated;
    });
}
