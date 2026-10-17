import { Prisma, type PrismaClient } from "@/generated/prisma/client";

/**
 * Shared root-or-tx client types. A transaction client exposes `$transaction`
 * too (calling it opens a savepoint), so {@link isRootClient} tells them apart
 * by identity: a root client is one passed to {@link registerRootClient}
 * (the `@/lib/prisma` singleton registers itself).
 */
export type TxClient = Prisma.TransactionClient;
export type DbClient = PrismaClient | TxClient;

const rootClients = new WeakSet<object>();

/** Mark a standalone client (the prisma singleton, the seed script's own) as a root client. */
export function registerRootClient<T extends PrismaClient>(client: T): T {
    rootClients.add(client);
    return client;
}

export function isRootClient(db: DbClient): db is PrismaClient {
    return rootClients.has(db);
}

/** A tx client's runtime `$transaction`, which the generated TransactionClient type omits. */
type NestableTxClient = TxClient & Pick<PrismaClient, "$transaction">;

function isNestable(db: DbClient): db is NestableTxClient {
    return "$transaction" in db;
}

/**
 * Run `fn` under `db`: opens a new transaction if `db` is a root client, or a
 * SAVEPOINT inside the caller's transaction if `db` is already a tx client.
 * Either way the work commits or rolls back with the caller, and an inner
 * failure the caller catches rolls back only the inner writes.
 */
export function withTx<T>(db: DbClient, fn: (tx: TxClient) => Promise<T>): Promise<T> {
    return isNestable(db) ? db.$transaction(fn) : fn(db);
}
