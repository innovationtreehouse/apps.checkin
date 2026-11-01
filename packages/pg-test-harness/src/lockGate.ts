/** A Prisma client or transaction client, reduced to the raw query these helpers run. */
export interface RawQueryClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<T>;
}

/** The server process behind `client`. Call it inside the transaction that holds the lock. */
export async function backendPid(client: RawQueryClient): Promise<number> {
  const [{ pid }] = await client.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  return pid;
}

/**
 * Resolves once `count` backends wait on `holderPid`, directly or queued behind another waiter.
 * Poll through a connection outside the holder's transaction.
 */
export async function waitersBehind(client: RawQueryClient, holderPid: number, count = 1): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [{ n }] = await client.$queryRaw<{ n: number }[]>`
      WITH RECURSIVE behind AS (
        SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND ${holderPid}::int = ANY(pg_blocking_pids(pid))
        UNION
        SELECT a.pid FROM pg_stat_activity a JOIN behind b ON b.pid = ANY(pg_blocking_pids(a.pid))
         WHERE a.datname = current_database()
      )
      SELECT count(*)::int AS n FROM behind`;
    if (n >= count) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`fewer than ${count} backends waiting behind ${holderPid}`);
}
