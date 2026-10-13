import type { TxClient } from "@/lib/db-client";
import type { ProgramParticipant, ProgramParticipantStatus } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import { adjustProgramInventory } from "@/lib/shopify";
import { LIVE_PERSON } from "@/lib/person/filters";

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

    const count = await tx.programParticipant.count({ where: { programId, person: LIVE_PERSON } });
    if (count + seats > maxParticipants) {
        throw new ProgramCapacityError(Math.max(0, maxParticipants - count));
    }
}

/**
 * Delete a PENDING participant and release its scholarship inventory hold
 * (+1), exactly once. This is the ONE implementation of "exit a participant"
 * shared by every code path that does it — manual self/admin withdrawal
 * (DELETE /api/programs/[id]/participants), the non-payment kick
 * (cron/pending-participants), and grace-period auto-withdrawal
 * (cron/scholarship-grace-expiry) — so the hold-ledger invariant (every
 * scholarship -1 comes back +1 exactly once) has one implementation, not
 * three.
 *
 * `delete()` IS the atomicity boundary: a given row can be deleted at most
 * once, so "was inventoryHeldAt set on the row we just deleted" can never be
 * double-counted even under concurrent callers — a second delete() throws
 * Prisma P2025 (row already gone), which callers handle as an idempotent
 * no-op and never reach this function for.
 *
 * `onlyStatus` makes the delete conditional on the row's status in the same
 * statement, so a payment that lands between a caller's check and this delete
 * cannot slip through; a mismatch throws P2025 like a missing row.
 *
 * Never throws on the Shopify leg (adjustProgramInventory already logs +
 * emails on failure); the boolean return lets the caller surface a
 * non-fatal warning the same way every other Shopify-adjusting endpoint does.
 */
export async function withdrawAndReleaseHold(
    programId: number,
    personId: number,
    program: { shopifyVariantId?: string | null },
    onlyStatus?: ProgramParticipantStatus,
): Promise<{ enrollment: ProgramParticipant; released: boolean; shopifyOk: boolean }> {
    const enrollment = await prisma.programParticipant.delete({
        where: { programId_personId: { programId, personId }, ...(onlyStatus && { status: onlyStatus }) },
    });

    if (!enrollment.inventoryHeldAt) {
        return { enrollment, released: false, shopifyOk: true };
    }

    const shopifyOk = await adjustProgramInventory(program, 1);
    return { enrollment, released: true, shopifyOk };
}
