import { execFileSync, spawnSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findMissingPartialIndexes, splicePartialIndexes, type IndexRow } from "./lib/partial-indexes";

/**
 * Coalesces the accumulated migrations on main into a single baseline
 * migration, ahead of a release — see docs/ops/MIGRATION_COALESCE_FLOW.md
 * for the policy this implements (migrations accumulate between releases;
 * they're usually coalesced via this script before a release; how many
 * migrations a release actually carries is a manual per-release call — no
 * CI gate enforces a count).
 *
 *   npx tsx scripts/coalesce-migrations.ts --scratch-url <postgres-url> [--commit]
 *   DATABASE_URL_SCRATCH=<postgres-url> npx tsx scripts/coalesce-migrations.ts [--commit]
 *
 * Defaults to a DRY RUN: builds and validates the candidate baseline but
 * writes nothing. Pass --commit to replace prisma/migrations/* with it and
 * emit the ledger-reconcile artifacts already-migrated environments need.
 *
 * --scratch-url must point at a disposable Postgres server/maintenance DB
 * (e.g. postgresql://user:pass@host:5433/postgres) — this script creates and
 * always drops its OWN temp DBs there. It refuses checkmein/checkin_dev/
 * checkin_prod as a guard against pointing it at a real environment.
 *
 * What "validate" means:
 *  1. Semantic schema identity: a fresh DB migrated through the FULL current
 *     chain (TRUTH) must dump the same schema (scripts/compare-schema-dumps.sh)
 *     as a fresh DB with only the generated candidate applied.
 *  2. Partial unique indexes survive: `prisma migrate diff --from-empty` has
 *     nothing in schema.prisma to reconstruct a partial (WHERE-clause) unique
 *     index from, and drops it silently. Detected by diffing TRUTH's
 *     pg_indexes against the candidate's; missing ones are spliced back in
 *     verbatim and the candidate is re-validated from scratch.
 *  3. No drift: `prisma migrate diff --exit-code` from the candidate DB
 *     against schema.prisma must be empty.
 */

const CHECKIN_APP_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(CHECKIN_APP_DIR, "..");
const MIGRATIONS_DIR = path.join(CHECKIN_APP_DIR, "prisma", "migrations");
const PROTECTED_DB_NAMES = ["checkmein", "checkin_dev", "checkin_prod"];

function arg(flag: string): string | undefined {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (flag: string) => process.argv.includes(flag);

function step(label: string) {
    console.log(`\n=== ${label} ===`);
}

function ensureCleanGitTree(): string {
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" });
    if (status.trim().length > 0) {
        throw new Error(`Git working tree is not clean — commit or stash before running this script:\n${status}`);
    }
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    if (branch === "HEAD") {
        throw new Error("Detached HEAD — check out a branch first (--commit rewrites prisma/migrations/ in place).");
    }
    return branch;
}

function guardScratchUrl(url: string) {
    let dbName: string;
    try {
        dbName = new URL(url).pathname.replace(/^\//, "").toLowerCase();
    } catch {
        throw new Error(`--scratch-url / DATABASE_URL_SCRATCH is not a valid postgres URL: ${url}`);
    }
    if (PROTECTED_DB_NAMES.includes(dbName)) {
        throw new Error(
            `--scratch-url points at "${dbName}", a real environment database. Point it at a neutral ` +
                `maintenance DB on a disposable scratch server instead (e.g. .../postgres) — this script ` +
                `creates and drops its own temp DBs there, it never touches the DB the URL itself names.`,
        );
    }
}

function withDatabase(url: string, dbName: string): string {
    const u = new URL(url);
    u.pathname = `/${dbName}`;
    return u.toString();
}

function createDatabase(adminUrl: string, dbName: string) {
    // DROP/CREATE DATABASE cannot run inside a transaction block, and psql
    // sends a single `-c` argument as one query string — even semicolon-
    // separated statements in it run as one implicit transaction. Two
    // separate `-c` invocations, not one combined string.
    execFileSync("psql", [adminUrl, "-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE IF EXISTS "${dbName}";`], {
        stdio: ["ignore", "pipe", "inherit"],
    });
    execFileSync("psql", [adminUrl, "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE "${dbName}";`], {
        stdio: ["ignore", "pipe", "inherit"],
    });
}

function dropDatabase(adminUrl: string, dbName: string) {
    try {
        execFileSync("psql", [adminUrl, "-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE);`], {
            stdio: ["ignore", "pipe", "inherit"],
        });
    } catch (e) {
        console.warn(`Warning: failed to drop temp DB "${dbName}" — clean it up manually.`, e);
    }
}

function applySql(url: string, sql: string) {
    const tmpFile = path.join(os.tmpdir(), `coalesce-candidate-${process.pid}.sql`);
    fs.writeFileSync(tmpFile, sql);
    execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-f", tmpFile], { stdio: ["ignore", "pipe", "inherit"] });
}

function applyFullChain(truthUrl: string) {
    console.log("Applying the full current migration chain to the TRUTH DB (prisma migrate deploy)...");
    const out = execFileSync("npx", ["prisma", "migrate", "deploy"], {
        cwd: CHECKIN_APP_DIR,
        env: { ...process.env, DATABASE_URL: truthUrl },
        encoding: "utf8",
    });
    console.log(out);
}

function generateCandidateSql(): string {
    console.log("Generating candidate baseline: prisma migrate diff --from-empty --to-schema=prisma/schema.prisma --script");
    const sql = execFileSync("npx", ["prisma", "migrate", "diff", "--from-empty", "--to-schema=prisma/schema.prisma", "--script"], {
        cwd: CHECKIN_APP_DIR,
        encoding: "utf8",
    });
    console.log(`Generated ${sql.split("\n").length} lines of candidate SQL.`);
    return sql;
}

function queryPartialIndexes(url: string): IndexRow[] {
    const sql = `SELECT indexname || chr(31) || indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexdef ILIKE '%WHERE%' ORDER BY indexname;`;
    const out = execFileSync("psql", [url, "-t", "-A", "-c", sql], { encoding: "utf8" });
    return out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
            const [indexname, indexdef] = line.split("\x1f");
            return { indexname, indexdef };
        });
}

function compareSchemas(urlA: string, urlB: string): { identical: boolean; report: string } {
    const scriptPath = path.join(__dirname, "compare-schema-dumps.sh");
    const result = spawnSync("bash", [scriptPath, urlA, urlB], { encoding: "utf8" });
    const report = [result.stdout, result.stderr].filter(Boolean).join("\n");
    if (result.status !== 0 && result.status !== 1) {
        throw new Error(`compare-schema-dumps.sh failed unexpectedly (exit ${result.status}):\n${report}`);
    }
    return { identical: result.status === 0, report };
}

function checkNoDrift(candidateUrl: string): void {
    const result = spawnSync(
        "npx",
        ["prisma", "migrate", "diff", "--from-config-datasource", "--to-schema=prisma/schema.prisma", "--exit-code"],
        { cwd: CHECKIN_APP_DIR, env: { ...process.env, DATABASE_URL: candidateUrl }, encoding: "utf8" },
    );
    if (result.status === 0) return;
    if (result.status === 2) {
        throw new Error(`Candidate baseline drifts from schema.prisma (migrate diff --exit-code):\n${result.stdout}\n${result.stderr}`);
    }
    throw new Error(`prisma migrate diff --exit-code failed unexpectedly (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
}

function migrationTimestamp(d = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function listMigrationDirs(): string[] {
    return fs
        .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
}

function sha256Hex(content: string): string {
    return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function renderReconcileSql(baselineName: string, checksumHex: string): string {
    return `-- Ledger reconcile for the "${baselineName}" coalesce baseline.
--
-- Run ONCE against every already-migrated environment (dev, prod) so
-- Prisma's ledger (_prisma_migrations) shows exactly this baseline as
-- applied, instead of \`prisma migrate deploy\` trying (and failing) to
-- replay the squashed history this migration replaced.
--
-- See docs/ops/MIGRATION_COALESCE_FLOW.md for the ECS one-off
-- command to run this against dev/prod. Safe to re-run (idempotent DELETE).
BEGIN;
DELETE FROM "_prisma_migrations";
INSERT INTO "_prisma_migrations"
    (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
VALUES
    (gen_random_uuid(), '${checksumHex}', '${baselineName}', now(), now(), 1);
COMMIT;
`;
}

function renderReconcileInstructions(baselineName: string, checksumHex: string): string {
    return `
=== Ledger reconcile required for already-migrated environments ===

prisma/migrations/${baselineName}/reconcile.sql   (checksum ${checksumHex})

Any environment that already ran the migrations this baseline replaces (dev,
prod) needs that file applied to its _prisma_migrations ledger BEFORE its
next \`prisma migrate deploy\` — otherwise that deploy looks for migrations
that no longer exist in the repo and fails.

Two honest paths (full commands in docs/ops/MIGRATION_COALESCE_FLOW.md):
  1. Preemptive: dev auto-deploys on every merge to main — run the ECS
     one-off reconcile task in the merge -> deploy window, before the
     automatic migrate step gets there.
  2. Reactive (simpler, still correct): let the automatic migrate step fail
     once, loudly (expected — it can't find the old chain in the ledger).
     Run the one-off reconcile task, then re-run the failed GitHub Actions
     job/workflow run. Its migrate step now finds the ledger already at this
     baseline and applies nothing new.

No CI gate checks migration count on a prod release anymore (manual team
call per MIGRATION_COALESCE_FLOW.md) — but if you've run this script, land
the coalesce PR and reconcile prod the same way, in the window between
merging and cutting that release.
`;
}

function writeBaseline(baselineName: string, sql: string, oldDirs: string[]): string {
    for (const dir of oldDirs) {
        fs.rmSync(path.join(MIGRATIONS_DIR, dir), { recursive: true, force: true });
    }
    const newDir = path.join(MIGRATIONS_DIR, baselineName);
    fs.mkdirSync(newDir, { recursive: true });
    const finalSql = sql.endsWith("\n") ? sql : `${sql}\n`;
    fs.writeFileSync(path.join(newDir, "migration.sql"), finalSql);
    return finalSql;
}

async function main() {
    const commit = hasFlag("--commit");
    const scratchUrl = arg("--scratch-url") ?? process.env.DATABASE_URL_SCRATCH;
    if (!scratchUrl) {
        throw new Error(
            "Provide a scratch Postgres server via --scratch-url <postgres-url> or DATABASE_URL_SCRATCH env " +
                "(point it at a maintenance DB like 'postgres' on a disposable server — this script creates/drops " +
                "its OWN temp DBs there, never checkmein/checkin_dev/checkin_prod).",
        );
    }
    guardScratchUrl(scratchUrl);

    const branch = ensureCleanGitTree();
    console.log(`Preflight OK — clean tree on branch "${branch}".`);

    const existingMigrations = listMigrationDirs();
    console.log(`Found ${existingMigrations.length} existing migration(s): ${existingMigrations.join(", ")}`);
    if (existingMigrations.length <= 1) {
        console.log("Nothing to coalesce (0 or 1 migration already) — exiting without changes.");
        return;
    }

    const ts = migrationTimestamp();
    const baselineName = `${ts}_coalesced_baseline`;
    const suffix = crypto.randomBytes(3).toString("hex");
    const truthDb = `coalesce_truth_${ts}_${suffix}`;
    const candidateDb = `coalesce_candidate_${ts}_${suffix}`;
    const truthUrl = withDatabase(scratchUrl, truthDb);
    const candidateUrl = withDatabase(scratchUrl, candidateDb);

    try {
        step("Build TRUTH DB (full current migration chain)");
        createDatabase(scratchUrl, truthDb);
        applyFullChain(truthUrl);

        step("Generate candidate baseline");
        let candidateSql = generateCandidateSql();

        let dumpDiff: { identical: boolean; report: string } | undefined;
        let truthPartialIndexes: IndexRow[] = [];
        const maxAttempts = 2; // 1 initial + 1 splice-and-retry; a 2nd miss means something's really wrong
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            step(`Validate candidate (attempt ${attempt}/${maxAttempts})`);
            createDatabase(scratchUrl, candidateDb);
            applySql(candidateUrl, candidateSql);

            dumpDiff = compareSchemas(truthUrl, candidateUrl);
            console.log(dumpDiff.report);

            truthPartialIndexes = queryPartialIndexes(truthUrl);
            const candidatePartialIndexes = queryPartialIndexes(candidateUrl);
            const missing = findMissingPartialIndexes(truthPartialIndexes, candidatePartialIndexes);

            if (dumpDiff.identical && missing.length === 0) {
                checkNoDrift(candidateUrl);
                console.log("No-drift check passed: candidate matches schema.prisma exactly.");
                break;
            }

            if (missing.length > 0 && attempt < maxAttempts) {
                console.log(
                    `Missing ${missing.length} partial unique index(es) in the candidate ` +
                        `(${missing.map((m) => m.indexname).join(", ")}) — splicing from TRUTH and re-validating from scratch.`,
                );
                candidateSql = splicePartialIndexes(candidateSql, missing);
                continue;
            }

            throw new Error(
                `Candidate baseline failed validation after ${attempt} attempt(s).\n` +
                    (dumpDiff.identical ? "" : "Schema dump comparison found real differences (see report above).\n") +
                    (missing.length > 0 ? `Still missing partial index(es) after splicing: ${missing.map((m) => m.indexname).join(", ")}\n` : ""),
            );
        }

        console.log(
            `\nValidation verdict: candidate baseline is semantically identical to the full current chain ` +
                `(${existingMigrations.length} migrations); ${truthPartialIndexes.length} partial unique index(es) verified; no drift vs schema.prisma.`,
        );

        if (!commit) {
            console.log("\nDRY RUN — no changes written. Re-run with --commit to replace prisma/migrations/ with this baseline.");
            return;
        }

        step("Writing coalesced baseline + reconcile artifacts");
        const finalSql = writeBaseline(baselineName, candidateSql, existingMigrations);
        const checksum = sha256Hex(finalSql);
        fs.writeFileSync(path.join(MIGRATIONS_DIR, baselineName, "reconcile.sql"), renderReconcileSql(baselineName, checksum));
        console.log(`Wrote prisma/migrations/${baselineName}/ (migration.sql + reconcile.sql).`);
        console.log(renderReconcileInstructions(baselineName, checksum));
    } finally {
        step("Dropping temp databases");
        dropDatabase(scratchUrl, truthDb);
        dropDatabase(scratchUrl, candidateDb);
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    });
}
