import type { TxClient } from "@/lib/db-client";

/**
 * Issue the next Person id from the `IdCounter` row named 'person' — the person
 * id is printed on a badge, and Aurora's sequence prefetch burns ~32 of them
 * per auto-pause.
 *
 * Never rewrite this as `MAX(id) + 1`: that REUSES ids. The adapter's `deleteUser`
 * hard-deletes a Person (not invoked today), and a new sign-up would then inherit
 * the deleted person's number, so every badge printed for the first would scan as
 * the second. `mintId.integration` case 1 is the test that stops that.
 *
 * The three clauses of the one statement: `ON CONFLICT` self-seeds (a `db push`
 * DB and the dev-reset TRUNCATE have no seed row); `GREATEST` stores a
 * sequence-written id (fixtures) in the counter at the next mint and never winds
 * the counter back, but a row above the counter that is deleted before that mint
 * goes unseen, and its id is reissued. `personIdMintGuard` keeps production creates
 * off the sequence, which keeps production off that path. `setval` pushes the
 * sequence up to the minted value so the reverse collision can't happen either.
 * Postgres requires UPDATE on the sequence for `setval` (USAGE/SELECT is not
 * enough). `setval` is non-transactional on purpose — a rollback leaves the gap
 * in the sequence, not in the counter.
 *
 * `TxClient`, not `DbClient`, so the mint is always paired with its `create`:
 * minting on the root client autocommits the increment on its own, and a failed
 * create then leaves the gap this exists to prevent. Where a call site has no
 * transaction, wrap the pair in `withTx(prisma, …)`.
 */
export async function mintPersonId(tx: TxClient): Promise<number> {
    const [row] = await tx.$queryRaw<{ value: number }[]>`
        WITH minted AS (
          INSERT INTO "IdCounter" ("name", "value")
          VALUES ('person', COALESCE((SELECT MAX("id") FROM "Person"), 0) + 1)
          ON CONFLICT ("name") DO UPDATE
             SET "value" = GREATEST("IdCounter"."value", COALESCE((SELECT MAX("id") FROM "Person"), 0)) + 1
          RETURNING "value"
        )
        SELECT m."value",
               setval(pg_get_serial_sequence('"Person"', 'id'), m."value")
        FROM minted m`;
    return row.value;
}
