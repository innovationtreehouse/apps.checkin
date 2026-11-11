/* eslint-disable @typescript-eslint/no-require-imports */
// Shared helpers for the integration-tier per-worker database machinery (A+B).
const { Client } = require('pg')

const TEST_DML_ROLE = 'checkin_test_dml'

/** Return `base` with its database name swapped for `db`. */
function withDb(base, db) {
    const u = new URL(base)
    u.pathname = `/${db}`
    return u.toString()
}

/** A client on the maintenance DB, where CREATE/DROP DATABASE is legal. */
function adminClient(base) {
    return new Client({ connectionString: withDb(base, 'postgres') })
}

/** Return `base` connecting as the non-superuser, non-owner test DML role. */
function withDmlRole(base) {
    const u = new URL(base)
    u.username = TEST_DML_ROLE
    u.password = TEST_DML_ROLE
    return u.toString()
}

/** Per-run DB name: namespaced by run id (B) AND worker id (A) so neither
 *  parallel workers nor concurrent jest invocations (worktrees, CI shards,
 *  multiple Bash calls) ever collide on the same database. */
function workerDbName(runId, workerId) {
    return `checkin_test_${runId}_${workerId}`
}

module.exports = { TEST_DML_ROLE, withDb, withDmlRole, adminClient, workerDbName }
