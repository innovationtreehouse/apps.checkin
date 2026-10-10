import { PrismaClient } from '@/generated/prisma/client'
import { Pool } from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { emailNormalizeExtension } from '@/lib/prismaEmailNormalize'
import { auroraResumeRetryExtension } from '@/lib/auroraResumeRetry'
import { registerRootClient } from '@/lib/db-client'

const connectionString = `${process.env.DATABASE_URL}`
const isTest = process.env.NODE_ENV === 'test'
// Tests default to a single connection so suites don't exhaust a small CI
// Postgres. TEST_DB_POOL_MAX lets a suite opt into a larger pool: the scan
// concurrency suite needs >= 2 so two scan transactions run on separate
// connections — that's the only way the per-participant advisory lock (not the
// $transaction wrapping) is what serializes them, matching production (pool 10).
const poolMax = isTest
    ? Number(process.env.TEST_DB_POOL_MAX ?? 1)
    : 10
const pool = new Pool({
    connectionString,
    max: poolMax,
    // Fail fast rather than hang forever if the pool can't get a connection (the
    // pg driver has NO default here — an exhausted/unresponsive server otherwise
    // blocks a new connection attempt indefinitely, with no error, no timeout).
    // Tests use a short timeout so a query that can't get the pool's only
    // connection (e.g. a root-client query inside a transaction) fails fast.
    connectionTimeoutMillis: isTest ? 2_000 : 10_000,
    // Off by default in the pg driver. Without it, a connection whose peer died
    // abruptly (SIGKILL'd process, torn-down background job — not a graceful
    // $disconnect()) looks alive to Postgres forever: no FIN was ever sent, and
    // nothing here ever probes it. If that connection was mid-transaction holding
    // a lock (e.g. the scan route's `pg_advisory_xact_lock`, checkin-app/src/app/api/scan/route.ts),
    // the lock is held until Postgres's OWN keepalive notices — which never
    // happens without this — so any later query needing that same lock hangs
    // indefinitely (issue #688: "20+ min no response", not fixed by --forceExit,
    // since that only governs whether the LATER run's own process exits, not
    // whether an EARLIER orphaned one is still silently holding a lock).
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    // Scale-to-zero invariant: idle connections MUST be reaped (and `min` must
    // stay 0) or this pool alone keeps the shared Aurora cluster from ever
    // auto-pausing — the cluster pauses only after ~5 minutes with zero
    // connections and zero queries. One minute (vs pg-pool's 10s default)
    // keeps a connection warm across a user's click-to-click gaps without
    // meaningfully delaying the pause window; if you need longer-lived warm
    // connections, wake latency is already handled by the
    // aurora-resume-retry extension below, not by holding sockets open.
    idleTimeoutMillis: 60_000,
    min: 0,
    // Server-side backstops for tests (#688 → #701's other half): #701 put
    // statement/idle-in-transaction timeouts into deploy/docker-compose.yml's
    // Postgres, but CI's `services:` container and the per-worker integration
    // DBs never got them — so an orphaned connection holding a lock
    // mid-transaction (keepAlive above only catches DEAD peers, not live
    // processes parked on an open transaction) stalled a whole CI run
    // unboundedly (the 2026-07-16 hang on main). These are session-level
    // settings the pg client applies on connect, so they cover every Postgres
    // a test run touches — CI service container, worktree DBs, local — with
    // one knob. Test-only: prod/Aurora long transactions stay governed by the
    // server's own configuration.
    ...(isTest
        ? {
              statement_timeout: 60_000,
              idle_in_transaction_session_timeout: 120_000,
          }
        : {}),
})
// In tests every file gets a fresh module registry, so each builds its own pool.
// Those pools must close on $disconnect or they leak connections until the worker
// process dies (parallel runs exhaust max_connections; --runInBand crashes). The
// pg adapter only ends an *external* pool when told to, so opt in under test. Prod
// keeps its single long-lived pool untouched.
const adapter = new PrismaPg(pool, isTest ? { disposeExternalPool: true } : undefined)

// The email-normalize extension lowercases Person.email at write time — the one
// choke point so no route can drift into storing a case-variant on the @unique
// column. The extension runs at runtime for every top-level person.* write
// (incl. $transaction and tx.person.* inside interactive transactions).
//
// We cast the extended client back to PrismaClient for the exported type. A
// $extends() result is a runtime superset but a DIFFERENT static type (it drops
// $on and re-parameterizes $transaction/TransactionClient), so leaking it into
// `ReturnType<typeof prismaClientSingleton>` would break every consumer typed
// against PrismaClient / Prisma.TransactionClient / DbClient. The person.* API
// is identical either way, so the cast hides nothing consumers use.
// The aurora-resume-retry extension (outermost, so it wraps everything) rides
// out the shared cluster's ~30s auto-pause resume instead of surfacing P1001
// as a generic 500 — see lib/auroraResumeRetry.ts and components/DbWakeNotice.tsx.
// Tests skip it: test Postgres never pauses, and retrying a pool-acquire timeout
// would turn an exhausted test pool into a 45s stall instead of an error.
const prismaClientSingleton = (): PrismaClient => {
    const client = new PrismaClient({ adapter }).$extends(emailNormalizeExtension)
    if (isTest) return client as unknown as PrismaClient
    return client.$extends(auroraResumeRetryExtension) as unknown as PrismaClient
}

declare const globalThis: {
    prismaGlobal: ReturnType<typeof prismaClientSingleton>;
} & typeof global;

// Registered on every module load: a dev reload reuses the global client but
// re-evaluates db-client's registry.
const prisma = registerRootClient(globalThis.prismaGlobal ?? prismaClientSingleton())

export default prisma

/**
 * Fast, retry-free liveness probe for the wake-notice endpoint
 * (/api/health/db). Goes straight to the pool — NOT through the extended
 * client — because the whole point is to answer "is the DB awake right now?"
 * quickly while the retry extension would sit in its ~45s resume loop.
 */
export async function pingDatabase(timeoutMs = 1_500): Promise<boolean> {
    try {
        await Promise.race([
            pool.query('SELECT 1'),
            new Promise((_, reject) => {
                const t = setTimeout(() => reject(new Error('db ping timeout')), timeoutMs)
                t.unref?.()
            }),
        ])
        return true
    } catch {
        return false
    }
}

if (process.env.NODE_ENV !== 'production') globalThis.prismaGlobal = prisma
