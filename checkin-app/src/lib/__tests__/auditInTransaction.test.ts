import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * An audit row commits with the change it records.
 * Every audit write on the root client (`prisma.`) or through a `DbClient` parameter
 * (`db.`) is listed here with its reason. The list may only shrink: a new site fails,
 * and a file with fewer sites than its entry fails until the entry is updated.
 */
const SRC = join(__dirname, "..", "..");
const SKIP_DIRS = new Set(["__tests__", "generated"]);
const AUDIT_WRITE = /\b(?:prisma|db)\.auditLog\.create(?:Many)?\(/g;

const REFUSAL = "by design: refusal, must survive the refusal it records";
const DB_PARAM = "by design: DbClient-param helper; callers pass their transaction client";

const ALLOWLIST: Record<string, { count: number; reason: string }> = {
    "app/api/cron/nightly/route.ts": {
        count: 1,
        reason: "by design: close summary is a board notice, each closed visit has its own row",
    },

    "lib/receipt/mailAliases.ts": { count: 1, reason: REFUSAL },
    "lib/membership/selfGrantGuard.ts": { count: 1, reason: `${REFUSAL}; the refusal paths pass the root client` },
    "lib/finance/reconcile/reversals.ts": { count: 1, reason: "by design: observation, nothing changed" },
    "app/api/finance-ops/s-read/sync/route.ts": { count: 1, reason: "by design: attempt at an outside system, written before the call" },
    "app/api/system-status/problems/retry/route.ts": { count: 1, reason: "by design: attempt at a library retry, written with its outcome" },
    "lib/membership/positionCheck.ts": { count: 1, reason: "by design: attempt at an outside send, written with its outcome" },
    "lib/finance/quickBooksPosting.ts": { count: 1, reason: "by design: catch-up request, written before the run it asks for" },
    "lib/shopifyWebhookReceipt.ts": { count: 1, reason: "by design: inbound delivery receipt" },
    "app/api/dev/shopify/orders-paid/route.ts": { count: 1, reason: "by design: dev-only mock marker" },
    "lib/attendance/close.ts": { count: 3, reason: DB_PARAM },
    "lib/membership/review.ts": { count: 1, reason: DB_PARAM },
    "lib/trusted-adult/service.ts": { count: 1, reason: DB_PARAM },
};

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(path);
        return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
    });
}

function countAuditWrites(source: string): number {
    return source.match(AUDIT_WRITE)?.length ?? 0;
}

function auditWriteCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const path of sourceFiles(SRC)) {
        const count = countAuditWrites(readFileSync(path, "utf8"));
        if (count > 0) counts[relative(SRC, path).split(sep).join("/")] = count;
    }
    return counts;
}

describe("audit writes outside a transaction", () => {
    it("matches root-client and DbClient-param writes, not transaction-client ones", () => {
        expect(countAuditWrites("await prisma.auditLog.create({ data })")).toBe(1);
        expect(countAuditWrites("await db.auditLog.createMany({ data })")).toBe(1);
        expect(countAuditWrites("await tx.auditLog.create({ data })")).toBe(0);
        expect(countAuditWrites("recordAudit(tx, actor, entry)")).toBe(0);
    });

    it("finds exactly the allowlisted sites", () => {
        const allowed = Object.fromEntries(Object.entries(ALLOWLIST).map(([path, { count }]) => [path, count]));
        expect(auditWriteCounts()).toEqual(allowed);
    });

    it("gives every entry a reason", () => {
        for (const { reason } of Object.values(ALLOWLIST)) expect(reason).toMatch(/^(to fix|by design):/);
    });
});
