import type { TxClient } from "@/lib/db-client";
import type { Prisma, ProgramParticipant, ProgramParticipantStatus } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import { adjustProgramInventory, type StockWriteOptions } from "@/lib/shopify";
import { LIVE_PERSON, ENROLLED_PARTICIPANT } from "@/lib/person/filters";
import { isSaleEnded } from "@/lib/programs/saleState";
import { STATES as ENROLLMENT_STATES, fromWhere } from "@/lib/programs/enrollmentState";

/** Seats Shopify counts as taken out of public stock: every ACTIVE seat and every held PENDING seat. */
export function countStockTakenSeats(programId: number): Promise<number> {
    return prisma.programParticipant.count({
        where: {
            programId,
            person: LIVE_PERSON,
            OR: [ENROLLMENT_STATES.ACTIVE.where, ENROLLMENT_STATES.PENDING_HELD.where, ENROLLMENT_STATES.PENDING_HELD_DENIED.where],
        },
    });
}

/** Thrown by {@link lockProgramAndCheckCapacity} when a program is full. */
export class ProgramCapacityError extends Error {
    constructor(public readonly spotsLeft: number) {
        super("Program has reached maximum capacity.");
        this.name = "ProgramCapacityError";
    }
}

/**
 * Lock the Program row and verify it has room for `seats` more enrollments,
 * run inside a transaction. Mirrors the lead-cap fix in
 * {@link file://./../household/leads.ts}: the bare count-then-create that
 * callers used to do is a TOCTOU race — under Postgres' default Read Committed
 * isolation two concurrent enrollers both count N and both insert, overfilling
 * the program. The `FOR UPDATE` lock serializes enrollers for this program: the
 * second blocks until the first commits, then re-counts and is rejected.
 *
 * No-op when `maxParticipants` is null (uncapped program). Throws
 * {@link ProgramCapacityError} (carrying remaining spots) when full. The lock
 * auto-releases on commit/rollback.
 */
export async function lockProgramAndCheckCapacity(
    tx: TxClient,
    programId: number,
    seats: number,
    maxParticipants: number | null,
): Promise<void> {
    // FOR UPDATE serializes enrollments for this program. The lock — not the
    // count — is what closes the race; Read Committed alone does not.
    await tx.$queryRaw`SELECT id FROM "Program" WHERE id = ${programId} FOR UPDATE`;

    if (maxParticipants === null) return;

    const count = await tx.programParticipant.count({ where: { programId, person: LIVE_PERSON, ...ENROLLED_PARTICIPANT } });
    if (count + seats > maxParticipants) {
        throw new ProgramCapacityError(Math.max(0, maxParticipants - count));
    }
}

/**
 * Put a seat taken out of Shopify without a sale back on sale (+1), unless the
 * program's sale has ended. Never throws on the Shopify leg
 * (adjustProgramInventory already logs + emails on failure); `shopifyOk` lets
 * the caller surface a non-fatal warning.
 */
async function returnSeat(
    programId: number,
    program: { shopifyVariantId?: string | null },
    stockOptions: StockWriteOptions,
): Promise<boolean> {
    const sale = await prisma.program.findUnique({
        where: { id: programId },
        select: { startAt: true, offSaleAt: true, saleEndedAt: true },
    });
    if (sale && isSaleEnded(sale)) return true;
    return adjustProgramInventory({ id: programId, shopifyVariantId: program.shopifyVariantId }, 1, "hold-release", stockOptions);
}

function onlyWhere(only?: ProgramParticipantStatus | Prisma.ProgramParticipantWhereInput): Prisma.ProgramParticipantWhereInput {
    return typeof only === "string" ? { status: only } : only ?? {};
}

/**
 * Delete a participant who never really took part (the never-there exit) and
 * put its seat back on sale (+1) when the seat was taken out of Shopify without
 * a payment, exactly once: a scholarship hold (inventoryHeldAt set), or a
 * comped/approved place whose -1 is on record (seatTakenWithoutSaleAt). A paid
 * place returns nothing; a person decides that at the store.
 *
 * `delete()` IS the atomicity boundary: a second delete() throws Prisma P2025
 * (row already gone), which callers handle as an idempotent no-op. `only` makes
 * the delete conditional on the row in the same statement, so a payment that
 * lands between a caller's check and this delete cannot slip through; a
 * mismatch throws P2025 like a missing row.
 */
export async function deleteAndReleaseHold(
    programId: number,
    personId: number,
    program: { shopifyVariantId?: string | null },
    only?: ProgramParticipantStatus | Prisma.ProgramParticipantWhereInput,
    stockOptions: StockWriteOptions = {},
): Promise<{ enrollment: ProgramParticipant; released: boolean; shopifyOk: boolean }> {
    const enrollment = await prisma.programParticipant.delete({
        where: { programId_personId: { programId, personId }, ...onlyWhere(only) },
    });

    const unsoldPlace = enrollment.status === "ACTIVE" && enrollment.seatTakenWithoutSaleAt !== null;
    if (!enrollment.inventoryHeldAt && !unsoldPlace) {
        return { enrollment, released: false, shopifyOk: true };
    }
    return { enrollment, released: true, shopifyOk: await returnSeat(programId, program, stockOptions) };
}

/**
 * Withdraw a participant who took part and left: the row stays as history,
 * status WITHDRAWN with endedAt set. A seat taken out of Shopify without a sale
 * goes back on sale (+1) exactly as {@link deleteAndReleaseHold} returns it.
 *
 * The status flip is the atomicity boundary: exactly one concurrent caller
 * moves the row to WITHDRAWN, and the rest get null. Once WITHDRAWN, no
 * PENDING-gated hold guard can match the row, so the hold is frozen before the
 * second CAS clears it. Null also means no row matched `only` or none exists;
 * the caller tells those apart.
 */
export async function withdrawParticipant(
    programId: number,
    personId: number,
    program: { shopifyVariantId?: string | null },
    only?: ProgramParticipantStatus | Prisma.ProgramParticipantWhereInput,
    stockOptions: StockWriteOptions = {},
): Promise<{ enrollment: ProgramParticipant; released: boolean; shopifyOk: boolean } | null> {
    const claimed = await prisma.$transaction(async (tx) => {
        const { count: won } = await tx.programParticipant.updateMany({
            where: { programId, personId, AND: [{ status: { not: "WITHDRAWN" } }, onlyWhere(only)] },
            data: { status: "WITHDRAWN", endedAt: new Date() },
        });
        if (won === 0) return null;
        const { count: heldReleased } = await tx.programParticipant.updateMany({
            where: { programId, personId, ...fromWhere("WITHDRAWN"), inventoryHeldAt: { not: null } },
            data: { inventoryHeldAt: null },
        });
        const enrollment = await tx.programParticipant.findUniqueOrThrow({ where: { programId_personId: { programId, personId } } });
        return { enrollment, released: heldReleased === 1 || enrollment.seatTakenWithoutSaleAt !== null };
    });
    if (!claimed) return null;
    if (!claimed.released) return { ...claimed, shopifyOk: true };
    return { ...claimed, shopifyOk: await returnSeat(programId, program, stockOptions) };
}
