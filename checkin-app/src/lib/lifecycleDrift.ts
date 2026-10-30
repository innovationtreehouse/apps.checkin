/**
 * Invariant-driven lifecycle drift — the scan + reconcile that is the payoff for
 * the two machines' `validate()` oracles.
 *
 * `scanLifecycleViolations` runs each machine's OWN `validate` over every live
 * row and returns the off-diagram set — read-only, shared by the System Status
 * surface (§6.2) and the reconciler cron. `runLifecycleReconcile` adds the one
 * safe auto-heal (enrollment I1) and reports the rest to the existing
 * sysadmin/board channel.
 *
 * This module NEVER re-derives an invariant: it calls the machines' `validate`,
 * so picture, panel, and reconciler cannot disagree with the guards.
 */
import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
    toRow as toEnrollmentRow,
    validate as validateEnrollment,
} from "@/lib/programs/enrollmentState";
import { validate as validateMembership } from "@/lib/membership/lifecycle";
import { systemActor } from "@/lib/auditActor";
import { reportShopifyFailure } from "@/lib/shopify/client";
import { changeProgramStockWith } from "@/lib/shopify/stock";
import { isSaleEnded } from "@/lib/programs/saleState";

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
    reported: number;
};

/**
 * Auto-heal the enrollment I1 rows (`status=ACTIVE` with `inventoryHeldAt` set):
 * a `-1` the webhook took but never released. Per row, a guarded `updateMany`
 * clears the stranded hold (CAS — a concurrent release wins and this no-ops),
 * and the missed +1 release commit together (changeProgramStockWith). §9 of the
 * enrollment doc. Audit-logs each heal (actorId 0 = system). Returns the number
 * healed. Per-row isolated; the Shopify leg is non-fatal.
 */
async function healEnrollmentI1(): Promise<number> {
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
            logger.error(
                `[lifecycle-reconcile] I1 heal failed for program ${row.programId} / person ${row.personId}:`,
                error,
            );
        }
    }
    return healed;
}

/**
 * Report one off-diagram row to the existing sysadmin/board channel — the SAME
 * path Shopify write failures use (IntegrationErrorLog → System Status "Link
 * Status" + admin/board email). Never throws.
 */
async function reportViolation(v: LifecycleViolation): Promise<void> {
    await reportShopifyFailure(
        "lifecycleReconcile",
        new Error(`${v.model} ${v.key}: off-diagram — invariant ${v.invariant} violated (status ${v.status})`),
        { model: v.model, key: v.key, status: v.status, invariant: v.invariant },
        `A ${v.model} row is off its lifecycle diagram (invariant ${v.invariant}) and needs a human to resolve — nothing was changed automatically.`,
    );
}

/**
 * The reconciler sweep: heal the one safe,
 * unambiguous case (enrollment I1), report every remaining violation, return a
 * summary. Complementary to the order-driven `lib/finance/reconcile/` — this
 * one is invariant-driven.
 */
export async function runLifecycleReconcile(): Promise<ReconcileSummary> {
    // Heal first, so the post-heal scan doesn't re-report a row we just fixed.
    const healed = await healEnrollmentI1();

    const { violations, scanned } = await scanLifecycleViolations();

    let reported = 0;
    for (const v of violations) {
        try {
            await reportViolation(v);
            reported++;
        } catch (error) {
            // reportShopifyFailure never throws, but keep the sweep isolated regardless.
            logger.error(`[lifecycle-reconcile] failed to report ${v.model} ${v.key}:`, error);
        }
    }

    return { scanned, violations: healed + violations.length, healed, reported };
}
