import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { DbClient } from "@/lib/db-client";
import { systemActor } from "@/lib/auditActor";
import { config } from "@/lib/config";
import { message, type ConfigCheck } from "@/lib/configHealth";
import { logger } from "@/lib/logger";
import type { SavedClass } from "@/lib/finance/quickBooksLists";

// The bucket check after each refresh of the QuickBooks lists copy (docs/rules/revenue.md):
// one alert per bucket and problem, recorded in the audit log, alerted again once cleared and back.

const ACTOR = systemActor("system:bucket-class-check");
const UNUSABLE = "BUCKET_UNUSABLE";
const USABLE = "BUCKET_USABLE";

type Problem = "class" | "archived-work";
type Finding = { bucketId: number; bucketName: string; problem: Problem; issue: string };

const keyOf = (f: { bucketId: number; problem: Problem }) => `${f.bucketId}:${f.problem}`;

function readFinding(bucketId: number, data: Prisma.JsonValue): (Finding & { check: string }) | null {
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    const { check, problem, bucketName, issue } = data;
    if (typeof check !== "string" || (problem !== "class" && problem !== "archived-work")) return null;
    return { check, bucketId, problem, bucketName: typeof bucketName === "string" ? bucketName : `#${bucketId}`, issue: typeof issue === "string" ? issue : "" };
}

/** Findings the check recorded and has not cleared, by bucket and problem. Reads the audit log only. */
async function openFindings(db: DbClient = prisma): Promise<Map<string, Finding>> {
    const rows = await db.auditLog.findMany({
        where: { tableName: "BudgetOwner", actorSystem: ACTOR.actorSystem },
        orderBy: { id: "asc" },
        select: { affectedEntityId: true, newData: true },
    });
    const open = new Map<string, Finding>();
    for (const row of rows) {
        const f = row.newData === null ? null : readFinding(row.affectedEntityId, row.newData);
        if (!f) continue;
        if (f.check === UNUSABLE) open.set(keyOf(f), { bucketId: f.bucketId, bucketName: f.bucketName, problem: f.problem, issue: f.issue });
        else open.delete(keyOf(f));
    }
    return open;
}

function classIssue(bucketName: string, classId: string, classes: SavedClass[]): string | null {
    const klass = classes.find((c) => c.id === classId);
    if (klass?.active) return null;
    const what = klass ? `is inactive in QuickBooks` : `is not in the app's copy of QuickBooks' lists`;
    const fix = klass ? "reactivate it in QuickBooks" : "restore it in QuickBooks";
    return `${bucketName}'s QuickBooks Class ${klass?.name ?? classId} ${what}. Lines in this bucket will wait until you pick an active Class or ${fix}.`;
}

/**
 * Checks every live bucket's Class against `classes` and every archived bucket for unfinished work,
 * records each new finding and each cleared one, and emails finance once per new finding after the commit.
 * A library that can't be read leaves the archived-work findings as they stand.
 */
export async function checkBucketClasses(classes: SavedClass[]): Promise<void> {
    const buckets = await prisma.budgetOwner.findMany({ select: { id: true, name: true, archivedAt: true, quickBooksClassId: true } });
    const found: Finding[] = [];
    const checked = new Set<Problem>(["class"]);
    for (const b of buckets) {
        if (b.archivedAt || !b.quickBooksClassId) continue;
        const issue = classIssue(b.name, b.quickBooksClassId, classes);
        if (issue) found.push({ bucketId: b.id, bucketName: b.name, problem: "class", issue });
    }
    try {
        const { unfinishedBucketUses } = await import("@/lib/finance/budgetOwners");
        for (const b of buckets.filter((x) => x.archivedAt)) {
            const uses = await unfinishedBucketUses(b.id);
            if (uses.length === 0) continue;
            const list = uses.map((u) => `${u.what}: ${u.count} (${u.where})`).join("; ");
            found.push({ bucketId: b.id, bucketName: b.name, problem: "archived-work", issue: `${b.name} is archived but still has unfinished work: ${list}. Restore it or move the work to another bucket.` });
        }
        checked.add("archived-work");
    } catch (err) {
        logger.error(`[bucket-class-check] archived buckets not checked: ${message(err)}`);
    }

    const now = new Set(found.map(keyOf));
    const before = await openFindings();
    const fresh = found.filter((f) => !before.has(keyOf(f)));
    const cleared = [...before.values()].filter((f) => checked.has(f.problem) && !now.has(keyOf(f)));
    if (fresh.length === 0 && cleared.length === 0) return;

    const recorded = await prisma.$transaction(async (tx) => {
        // Two refreshes at once: only one records, and so only one emails, each finding.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bucket-class-check'))`;
        const open = await openFindings(tx);
        const newly = fresh.filter((f) => !open.has(keyOf(f)));
        const gone = cleared.filter((f) => open.has(keyOf(f)));
        const row = (check: string) => (f: Finding) => ({
            ...ACTOR,
            action: "EDIT" as const,
            tableName: "BudgetOwner",
            affectedEntityId: f.bucketId,
            newData: { check, problem: f.problem, bucketName: f.bucketName, issue: f.issue },
        });
        await tx.auditLog.createMany({ data: [...newly.map(row(UNUSABLE)), ...gone.map(row(USABLE))] });
        return newly;
    });
    // After the commit: a failed send loses that one email and never doubles it.
    const { emailAlert } = await import("@/lib/emailRecipients");
    for (const f of recorded) {
        await emailAlert("finance.bucketClassUnusable", { bucketName: f.bucketName, issue: f.issue, actionLink: `${config.baseUrl()}/budgets` });
    }
}

const id = "budget-bucket-classes";
const label = "Budget buckets: QuickBooks Classes";

/** The System Status row for the check's open findings. Reads the audit log and the copy's status, never QuickBooks. */
export async function bucketClassesCheck(): Promise<ConfigCheck> {
    try {
        const { quickBooksListsStatus } = await import("@/lib/finance/quickBooksLists");
        if ((await quickBooksListsStatus()).length === 0) return { id, label, ok: true, detail: "Not checked: the QuickBooks lists have not been copied yet." };
        const open = [...(await openFindings()).values()];
        return open.length === 0
            ? { id, label, ok: true, detail: "Every live bucket's Class is active." }
            : { id, label, ok: false, detail: open.map((f) => f.issue).join(" ") };
    } catch (err) {
        return { id, label, ok: false, detail: `Could not read it: ${message(err)}.` };
    }
}
