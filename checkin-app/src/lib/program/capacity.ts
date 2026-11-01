import type { TxClient } from "@/lib/db-client";
import type { Prisma, ProgramParticipant, ProgramParticipantStatus } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import { changeProgramStockWith, type StockWriteOptions } from "@/lib/shopify/stock";
import { LIVE_PERSON, ENROLLED_PARTICIPANT } from "@/lib/person/filters";
import { isSaleEnded } from "@/lib/programs/saleState";
import { ENROLLMENT_WRITES, STATES as ENROLLMENT_STATES } from "@/lib/programs/enrollmentState";

/** Seats Shopify counts as taken out of public stock: every ACTIVE seat and every held PENDING seat. */
export function countStockTakenSeats(programId: number, db: TxClient = prisma): Promise<number> {
    return db.programParticipant.count({
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
 * run inside a transaction. Mirrors the lead cap in
 * {@link file://./../household/leads.ts}: a bare count-then-create
 * is a TOCTOU race — under Postgres' default Read Committed
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

type Only = ProgramParticipantStatus | Prisma.ProgramParticipantWhereInput;

function onlyWhere(only?: Only): Prisma.ProgramParticipantWhereInput {
    return typeof only === "string" ? { status: only } : only ?? {};
}

/** +1 when a seat taken out of Shopify without a sale comes back, unless the sale has ended. */
async function seatReturnDelta(tx: TxClient, programId: number, released: boolean): Promise<number> {
    if (!released) return 0;
    const sale = await tx.program.findUnique({ where: { id: programId }, select: { startAt: true, offSaleAt: true, saleEndedAt: true } });
    return sale && isSaleEnded(sale) ? 0 : 1;
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
 *
 * Never throws on the Shopify leg (the stock writer already logs + emails on
 * failure); `shopifyOk` lets the caller surface a non-fatal warning.
 */
export async function deleteAndReleaseHold(
    programId: number,
    personId: number,
    program: { shopifyVariantId?: string | null },
    only?: Only,
    stockOptions: StockWriteOptions = {},
): Promise<{ enrollment: ProgramParticipant; released: boolean; shopifyOk: boolean }> {
    const { result, landed } = await changeProgramStockWith({ id: programId, shopifyVariantId: program.shopifyVariantId }, "hold-release", async (tx) => {
        const enrollment = await tx.programParticipant.delete({
            where: { programId_personId: { programId, personId }, ...onlyWhere(only) },
        });
        const unsoldPlace = enrollment.status === "ACTIVE" && enrollment.seatTakenWithoutSaleAt !== null;
        const released = !!enrollment.inventoryHeldAt || unsoldPlace;
        return { result: { enrollment, released }, delta: await seatReturnDelta(tx, programId, released) };
    }, stockOptions);
    return { ...result, shopifyOk: landed };
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
    only?: Only,
    stockOptions: StockWriteOptions = {},
): Promise<{ enrollment: ProgramParticipant; released: boolean; shopifyOk: boolean } | null> {
    const { result, landed } = await changeProgramStockWith({ id: programId, shopifyVariantId: program.shopifyVariantId }, "hold-release", async (tx) => {
        const { count: won } = await tx.programParticipant.updateMany({
            where: { programId, personId, AND: [ENROLLMENT_WRITES.withdraw.where, onlyWhere(only)] },
            data: { ...ENROLLMENT_WRITES.withdraw.data(), endedAt: new Date() },
        });
        if (won === 0) return { result: null, delta: 0 };
        const { count: heldReleased } = await tx.programParticipant.updateMany({
            where: { programId, personId, ...ENROLLMENT_WRITES.releaseWithdrawnHold.where },
            data: ENROLLMENT_WRITES.releaseWithdrawnHold.data(),
        });
        const enrollment = await tx.programParticipant.findUniqueOrThrow({ where: { programId_personId: { programId, personId } } });
        const released = heldReleased === 1 || enrollment.seatTakenWithoutSaleAt !== null;
        return { result: { enrollment, released }, delta: await seatReturnDelta(tx, programId, released) };
    }, stockOptions);
    return result && { ...result, shopifyOk: landed };
}
