import { withTx, type DbClient, type TxClient } from "@/lib/db-client";

/**
 * Two-argument advisory lock, a different key from every per-person
 * `pg_advisory_xact_lock(personId)` lock. Lock order: a transaction takes all
 * its person locks first, then the facility lock, and no person lock after it.
 * That order is what keeps the two from deadlocking.
 *
 * Taken by every check-in that depends on facility-open state and by the
 * facility-wide close sweep, so a concurrent non-keyholder check-in cannot
 * land an open visit in a just-closed facility.
 */
export const FACILITY_ADVISORY_CLASS = 1;
export const FACILITY_ADVISORY_KEY = 0;

export async function lockFacility(tx: TxClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FACILITY_ADVISORY_CLASS}::int, ${FACILITY_ADVISORY_KEY}::int)`;
}

/** Acquire the facility lock, then run `fn`. Opens a transaction when `db` is the root client. */
export function withFacilityLock<T>(db: DbClient, fn: (tx: TxClient) => Promise<T>): Promise<T> {
    return withTx(db, async (tx) => {
        await lockFacility(tx);
        return fn(tx);
    });
}
