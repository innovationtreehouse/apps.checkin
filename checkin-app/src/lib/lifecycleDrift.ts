/**
 * Invariant-driven lifecycle drift — the scan + reconcile that is the payoff for
 * the two machines' `validate()` oracles.
 *
 * `scanLifecycleViolations` runs each machine's OWN `validate` over every live
 * row and returns the off-diagram set — read-only, shared by the System Status
 * surface (§6.2) and the reconciler cron. `runLifecycleReconcile` adds the one
 * safe auto-heal (enrollment I1) and sends sysadmins and the board one digest of
 * the rest.
 *
 * This module NEVER re-derives an invariant: it calls the machines' `validate`,
 * so picture, panel, and reconciler cannot disagree with the guards.
 */
import prisma from "@/lib/prisma";
import { config } from "@/lib/config";
import { emailSysadminsAndBoard } from "@/lib/emailRecipients";
import { logger, logIntegrationError } from "@/lib/logger";
import {
    toRow as toEnrollmentRow,
    validate as validateEnrollment,
} from "@/lib/programs/enrollmentState";
import { validate as validateMembership } from "@/lib/membership/lifecycle";
import { systemActor } from "@/lib/auditActor";
import { changeProgramStockWith } from "@/lib/shopify/stock";
import { isSaleEnded } from "@/lib/programs/saleState";

const DRIFT_SOURCE = "lifecycle-drift";

export type LifecycleModel = "ProgramParticipant" | "OrgMembershipProcess";

/** One off-diagram row: which model, a human key, the status, and the broken invariant. */
export type LifecycleViolation = {
    model: LifecycleModel;
    /** Human-readable row key (composite for ProgramParticipant, id for the process). */
    key: string;
    status: string;
    /** The invariant name `validate` returned (e.g. "I1", "active-is-bg-cleared"). */
    invariant: string;
};

/**
 * Scan BOTH models with their own `validate()` and return every off-diagram row.
 * Read-only. Nullable timestamps are collapsed to presence booleans — the shape
 * `validate` expects (never a `Date | null`).
 */
export async function scanLifecycleViolations(): Promise<{
    violations: LifecycleViolation[];
    scanned: number;
}> {
    const violations: LifecycleViolation[] = [];

    const enrollments = await prisma.programParticipant.findMany({
        select: {
            programId: true,
            personId: true,
            status: true,
            inventoryHeldAt: true,
            isPaymentPlanRequested: true,
            paymentPlanDeniedAt: true,
        },
    });
    for (const e of enrollments) {
        const bad = validateEnrollment(toEnrollmentRow(e));
        if (bad) {
            violations.push({
                model: "ProgramParticipant",
                key: `program ${e.programId} / person ${e.personId}`,
                status: e.status,
                invariant: bad.invariant,
            });
        }
    }

    // Every kind is scanned; `kind` goes to `validate` because the machine's invariants
    // are kind-specific, and deciding which rows to skip HERE would re-derive them.
    const processes = await prisma.orgMembershipProcess.findMany({
        select: {
            id: true,
            status: true,
            kind: true,
            contractSignedAt: true,
            bgConsentAt: true,
            bgClearedAt: true,
            paidAt: true,
        },
    });
    for (const p of processes) {
        const bad = validateMembership({
            status: p.status,
            kind: p.kind,
            contractSignedAt: p.contractSignedAt !== null,
            bgConsentAt: p.bgConsentAt !== null,
            bgClearedAt: p.bgClearedAt !== null,
            paidAt: p.paidAt !== null,
        });
        if (bad) {
            violations.push({
                model: "OrgMembershipProcess",
                key: `process ${p.id}`,
                status: p.status,
                invariant: bad.invariant,
            });
        }
    }

    return { violations, scanned: enrollments.length + processes.length };
}

/** Summary returned by the reconciler cron. */
export type ReconcileSummary = {
    scanned: number;
    violations: number;
    healed: number;
    /** Off-diagram rows in a digest that reached someone. */
    reported: number;
    /** Off-diagram rows not in any earlier delivered digest. */
    newViolations: number;
    /** Heals that threw, plus one if a digest reached nobody. Read by `withCron`. */
    failed: number;
};

/**
 * Auto-heal the enrollment I1 rows (`status=ACTIVE` with `inventoryHeldAt` set):
 * a `-1` the webhook took but never released. Per row, a guarded `updateMany`
 * clears the stranded hold (CAS — a concurrent release wins and this no-ops),
 * and the missed +1 release commit together (changeProgramStockWith). §9 of the
 * enrollment doc. Audit-logs each heal (actorId 0 = system). Returns the rows
 * healed and the rows whose heal threw. Per-row isolated; a Shopify leg that did
 * not land is owed in the stock carry, so it is not a failed heal.
 */
async function healEnrollmentI1(): Promise<{ healed: number; failed: number }> {
    // status=ACTIVE ∧ inventoryHeldAt≠null IS the I1 set — no re-derivation.
    const stranded = await prisma.programParticipant.findMany({
        where: { status: "ACTIVE", inventoryHeldAt: { not: null } },
        select: {
            programId: true,
            personId: true,
            inventoryHeldAt: true,
            program: { select: { shopifyVariantId: true, startAt: true, offSaleAt: true, saleEndedAt: true } },
        },
    });

    let healed = 0;
    let failed = 0;
    for (const row of stranded) {
        try {
            // Guarded CAS: only the caller that flips held→null gets count 1 and
            // owns the compensating +1; a racing release/withdrawal takes count 0.
            // The clear and its +1 commit together. Once the sale has ended the seat is not resold: no +1.
            const saleEnded = isSaleEnded(row.program);
            const { result: cleared, landed: shopifyOk } = await changeProgramStockWith(
                { id: row.programId, shopifyVariantId: row.program.shopifyVariantId },
                "reconcile-heal",
                async (tx) => {
                    const { count } = await tx.programParticipant.updateMany({
                        where: {
                            programId: row.programId,
                            personId: row.personId,
                            status: "ACTIVE",
                            inventoryHeldAt: { not: null },
                        },
                        data: { inventoryHeldAt: null },
                    });
                    return { result: count === 1, delta: count === 1 && !saleEnded ? 1 : 0 };
                },
            );
            if (!cleared) continue; // already cleared under us — not ours to release.
            if (!shopifyOk) {
                logger.error(
                    `[lifecycle-reconcile] I1 heal cleared hold for program ${row.programId} / person ${row.personId} but the +1 release failed (see Shopify error alert).`,
                );
            }

            await prisma.auditLog.create({
                data: {
                    ...systemActor("cron:lifecycle-reconcile"),
                    action: "EDIT",
                    tableName: "ProgramParticipant",
                    affectedEntityId: row.personId,
                    secondaryAffectedEntity: row.programId,
                    oldData: {
                        status: "ACTIVE",
                        inventoryHeldAt: row.inventoryHeldAt?.toISOString() ?? null,
                        reason: "lifecycle-reconcile: enrollment I1 (stranded hold on ACTIVE)",
                    },
                    newData: { inventoryHeldAt: null, shopifyReleaseOk: shopifyOk, releaseSkippedSaleEnded: saleEnded },
                },
            });
            healed++;
        } catch (error) {
            // Per-row isolation: one bad row never aborts the sweep.
            failed++;
            logger.error(
                `[lifecycle-reconcile] I1 heal failed for program ${row.programId} / person ${row.personId}:`,
                error,
            );
        }
    }
    return { healed, failed };
}

type DriftIdentity = Pick<LifecycleViolation, "key" | "invariant"> & { model: string };

const driftIdentity = (row: DriftIdentity) => `${row.model}|${row.key}|${row.invariant}`;

const driftLines = (rows: LifecycleViolation[]) =>
    rows.map((v) => `${v.model} ${v.key}: invariant ${v.invariant} (status ${v.status})`).join("\n") || "None";

/**
 * Send one digest of the off-diagram rows, split by LifecycleDriftReport into new
 * and still present, and sync that record. A row that leaves the set loses its
 * record, so its return counts as new. A row joins the record only once a digest
 * reached someone, so a digest nobody received leaves it new for the next run.
 */
async function reportDrift(violations: LifecycleViolation[]): Promise<{ newViolations: number; delivered: boolean }> {
    const known = await prisma.lifecycleDriftReport.findMany({ select: { id: true, model: true, key: true, invariant: true } });
    const knownIdentities = new Set(known.map(driftIdentity));
    const currentIdentities = new Set(violations.map(driftIdentity));

    const left = known.filter((r) => !currentIdentities.has(driftIdentity(r))).map((r) => r.id);
    if (left.length > 0) await prisma.lifecycleDriftReport.deleteMany({ where: { id: { in: left } } });
    if (violations.length === 0) return { newViolations: 0, delivered: true };

    const fresh = violations.filter((v) => !knownIdentities.has(driftIdentity(v)));
    const stillPresent = violations.filter((v) => knownIdentities.has(driftIdentity(v)));

    if (fresh.length > 0) {
        await logIntegrationError(DRIFT_SOURCE, `${fresh.length} new off-diagram lifecycle row(s)`, { rows: fresh });
    }
    const delivered = await emailSysadminsAndBoard("lifecycle.driftDigest", {
        newCount: String(fresh.length),
        stillPresentCount: String(stillPresent.length),
        newList: driftLines(fresh),
        stillPresentList: driftLines(stillPresent),
        actionLink: `${config.baseUrl()}/system-status/lifecycle`,
    });
    if (delivered && fresh.length > 0) {
        await prisma.lifecycleDriftReport.createMany({
            data: fresh.map(({ model, key, invariant }) => ({ model, key, invariant })),
            skipDuplicates: true,
        });
    }
    return { newViolations: fresh.length, delivered };
}

/**
 * The reconciler sweep: heal the one safe, unambiguous case (enrollment I1),
 * report every remaining violation in one digest, return a summary. Complementary
 * to the order-driven `lib/finance/reconcile/` — this one is invariant-driven.
 */
export async function runLifecycleReconcile(): Promise<ReconcileSummary> {
    // Heal first, so the post-heal scan doesn't re-report a row we just fixed.
    const { healed, failed: healFailures } = await healEnrollmentI1();

    const { violations, scanned } = await scanLifecycleViolations();
    const { newViolations, delivered } = await reportDrift(violations);

    return {
        scanned,
        violations: healed + violations.length,
        healed,
        reported: delivered ? violations.length : 0,
        newViolations,
        failed: healFailures + (delivered ? 0 : 1),
    };
}
