import { withTx, type DbClient, type TxClient } from "@/lib/db-client";

/**
 * Two-argument advisory-lock space. Independent of the per-person
 * `pg_advisory_xact_lock(personId)` locks (#250): a 1-arg lock never conflicts
 * with a 2-arg lock, so this cannot deadlock against a person lock.
 *
 * Taken by every check-in that depends on facility-open state and by the
 * facility-wide close sweep, so a concurrent non-keyholder check-in cannot
 * land an open visit in a just-closed facility (#254).
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
