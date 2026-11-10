import prisma from "@/lib/prisma";
import { jsonField } from "@/lib/membership/checkStanding";
import { Prisma } from "@/generated/prisma/client";
import { PAST_PAGE_SIZE } from "./paymentPlanHistoryPage";

export type PaymentPlanOutcome = "APPROVED" | "REFUSED";

type Decision = { id: string; outcome: PaymentPlanOutcome; decidedAt: Date | null; decidedById: number | null };

/**
 * Outcome a program decision's audit row records, or null for any other ProgramParticipant
 * edit. A decision writes only the fields it changed; a withdrawal or refund writes the
 * whole row, ids included, so a row carrying `personId` is never a decision.
 */
export function programAuditOutcome(newData: Prisma.JsonValue | null): PaymentPlanOutcome | null {
    if (jsonField(newData, "isPaymentPlanRequested") !== false || jsonField(newData, "personId") !== undefined) return null;
    if (jsonField(newData, "status") === "ACTIVE" && typeof jsonField(newData, "wasOrgMemberAtApproval") === "boolean") return "APPROVED";
    if (typeof jsonField(newData, "paymentPlanDeniedAt") === "string") return "REFUSED";
    if (jsonField(newData, "reason") === "payment_plan_denied_no_hold") return "REFUSED";
    return null;
}

/** Outcome a membership decision's audit row records, or null for any other process edit. */
export function membershipAuditOutcome(newData: Prisma.JsonValue | null): PaymentPlanOutcome | null {
    if (jsonField(newData, "paymentPlanApproved") === true) return "APPROVED";
    if (jsonField(newData, "paymentPlanDenied") === true) return "REFUSED";
    return null;
}

/** Newest first; a decision known only from a stamp without a date sorts last. */
function newestFirst(a: Decision, b: Decision): number {
    return (b.decidedAt?.getTime() ?? -Infinity) - (a.decidedAt?.getTime() ?? -Infinity);
}

function pageOf<T extends Decision>(rows: T[], page: number): T[] {
    return rows.sort(newestFirst).slice(page * PAST_PAGE_SIZE, (page + 1) * PAST_PAGE_SIZE);
}

async function personNames(ids: Iterable<number>) {
    const people = await prisma.person.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true, email: true } });
    return new Map(people.map((p) => [p.id, p]));
}

// The audit rows that record a program decision, matched in the database. A whole-row
// snapshot (enrollment, withdrawal, refund) carries `personId`; a decision never does.
export const PROGRAM_DECISION_AUDIT: Prisma.AuditLogWhereInput = {
    tableName: "ProgramParticipant",
    AND: [
        { newData: { path: ["isPaymentPlanRequested"], equals: false } },
        { newData: { path: ["personId"], equals: Prisma.DbNull } },
    ],
    OR: [
        { AND: [{ newData: { path: ["status"], equals: "ACTIVE" } }, { newData: { path: ["wasOrgMemberAtApproval"], equals: true } }] },
        { AND: [{ newData: { path: ["status"], equals: "ACTIVE" } }, { newData: { path: ["wasOrgMemberAtApproval"], equals: false } }] },
        { newData: { path: ["paymentPlanDeniedAt"], string_contains: "T" } },
        { newData: { path: ["reason"], equals: "payment_plan_denied_no_hold" } },
    ],
};

// ponytail: reads every decision and pages in memory — fine at a few hundred
// requests a year; move paging into SQL if the history reaches the thousands.
export async function programPaymentPlanHistory(page: number) {
    const [audits, stamped] = await Promise.all([
        prisma.auditLog.findMany({
            where: PROGRAM_DECISION_AUDIT,
            select: { id: true, timestamp: true, actorId: true, affectedEntityId: true, secondaryAffectedEntity: true, newData: true },
        }),
        prisma.programParticipant.findMany({
            where: { OR: [{ wasOrgMemberAtApproval: { not: null } }, { paymentPlanDeniedAt: { not: null } }] },
            select: { programId: true, personId: true, wasOrgMemberAtApproval: true, paymentPlanDeniedAt: true, seatTakenWithoutSaleAt: true },
        }),
    ]);

    const decisions: (Decision & { programId: number; personId: number })[] = [];
    const audited = new Set<string>();
    for (const a of audits) {
        const outcome = programAuditOutcome(a.newData);
        if (!outcome || a.secondaryAffectedEntity === null) continue;
        audited.add(`${a.secondaryAffectedEntity}:${a.affectedEntityId}`);
        decisions.push({ id: `audit:${a.id}`, outcome, decidedAt: a.timestamp, decidedById: a.actorId, programId: a.secondaryAffectedEntity, personId: a.affectedEntityId });
    }
    // A record with any audited decision is told by its audit rows; its stamps hold only the latest state.
    for (const p of stamped) {
        const key = `${p.programId}:${p.personId}`;
        if (audited.has(key)) continue;
        const approved = p.wasOrgMemberAtApproval !== null;
        decisions.push({
            id: `stamp:${key}`,
            outcome: approved ? "APPROVED" : "REFUSED",
            decidedAt: approved ? p.seatTakenWithoutSaleAt : p.paymentPlanDeniedAt,
            decidedById: null,
            programId: p.programId,
            personId: p.personId,
        });
    }

    const rows = pageOf(decisions, page);
    const [people, programs] = await Promise.all([
        personNames(rows.flatMap((r) => (r.decidedById === null ? [r.personId] : [r.personId, r.decidedById]))),
        prisma.program.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.programId))] } }, select: { id: true, name: true } }),
    ]);
    const programName = new Map(programs.map((p) => [p.id, p.name]));
    return rows.map((r) => ({
        id: r.id,
        programId: r.programId,
        personId: r.personId,
        personName: people.get(r.personId)?.name ?? null,
        personEmail: people.get(r.personId)?.email ?? null,
        programName: programName.get(r.programId) ?? null,
        outcome: r.outcome,
        decidedAt: r.decidedAt,
        decidedById: r.decidedById,
        decidedByName: r.decidedById === null ? null : people.get(r.decidedById)?.name ?? null,
    }));
}

// ponytail: same in-memory paging ceiling as programPaymentPlanHistory.
export async function membershipPaymentPlanHistory(page: number) {
    const [audits, stamped] = await Promise.all([
        prisma.auditLog.findMany({
            where: {
                tableName: "OrgMembershipProcess",
                OR: [{ newData: { path: ["paymentPlanApproved"], equals: true } }, { newData: { path: ["paymentPlanDenied"], equals: true } }],
            },
            select: { id: true, timestamp: true, actorId: true, affectedEntityId: true, newData: true },
        }),
        // A certified payment on a process that asked for a plan is that plan's approval.
        prisma.orgMembershipProcess.findMany({
            where: { manualPaymentById: { not: null }, scholarshipRequestKind: { not: null }, isPaymentPlanRequested: false },
            select: { id: true, manualPaymentById: true, paidAt: true },
        }),
    ]);

    const decisions: (Decision & { processId: number })[] = [];
    const audited = new Set<number>();
    for (const a of audits) {
        const outcome = membershipAuditOutcome(a.newData);
        if (!outcome) continue;
        audited.add(a.affectedEntityId);
        decisions.push({ id: `audit:${a.id}`, outcome, decidedAt: a.timestamp, decidedById: a.actorId, processId: a.affectedEntityId });
    }
    for (const p of stamped) {
        if (audited.has(p.id)) continue;
        decisions.push({ id: `stamp:${p.id}`, outcome: "APPROVED", decidedAt: p.paidAt, decidedById: p.manualPaymentById, processId: p.id });
    }

    const rows = pageOf(decisions, page);
    const [people, processes] = await Promise.all([
        personNames(rows.flatMap((r) => (r.decidedById === null ? [] : [r.decidedById]))),
        prisma.orgMembershipProcess.findMany({
            where: { id: { in: [...new Set(rows.map((r) => r.processId))] } },
            select: { id: true, orgMembership: { select: { household: { select: { id: true, name: true } } } } },
        }),
    ]);
    const household = new Map(processes.map((p) => [p.id, p.orgMembership?.household ?? null]));
    return rows.map((r) => ({
        id: r.id,
        processId: r.processId,
        householdId: household.get(r.processId)?.id ?? null,
        householdName: household.get(r.processId)?.name ?? null,
        outcome: r.outcome,
        decidedAt: r.decidedAt,
        decidedById: r.decidedById,
        decidedByName: r.decidedById === null ? null : people.get(r.decidedById)?.name ?? null,
    }));
}

