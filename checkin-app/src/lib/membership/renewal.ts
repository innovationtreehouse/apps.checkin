import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import { ServiceError } from "@checkin/component-kit";
import { RENEWAL_ERROR_STATUS } from "@/lib/domainErrorResponse";
import { isPrismaError } from "@/lib/prismaUniqueViolation";
import { logger } from "@/lib/logger";
import { IN_FLIGHT_INITIAL, IN_FLIGHT_RENEWAL, asHouseholdProcess, handledThisCycleWhere, fromWhere } from "@/lib/membership/lifecycle";
import { raiseDeniedHouseholdActivity } from "@/lib/membership/householdStatus";
import { personActor, systemActor } from "@/lib/auditActor";
import { isRecheckPolicySet } from "@/lib/membership/bgRecheckPolicy";
import { clearNotRenewingInTx } from "@/lib/membership/notRenewing";
import { membershipYearLabel, membershipYearStart, nextBoundary, upcomingBoundary, monthsBefore, renewalWindow, membershipYearCycle, liveMembershipYear, grantableYears, RENEWAL_LEAD_MONTHS } from "@/lib/programYear";
import { orgToday } from "@/lib/appSettings";
import { lockProcessRows } from "@/lib/lockOrder";

export { nextBoundary, upcomingBoundary, monthsBefore, renewalWindow, membershipYearCycle, liveMembershipYear, grantableYears };

/**
 * Annual renewal. A common membership-year boundary (BoardSettings) drives every
 * household. Inside the two-month window before it, the board's "Open renewals"
 * button opens a RENEWAL process at PENDING_RENEWAL for every ACTIVE household not
 * already handled this cycle — the membership stays ACTIVE throughout.
 *
 * When the member begins renewal they enter the SAME external step a new applicant
 * gets (PENDING_EXTERNAL_ACTION): a fresh membership agreement is signed EVERY
 * cycle, and the background-check rule decides the other half — if EITHER parent's
 * background check is still valid at the boundary (lastBackgroundCheck within
 * BoardSettings.bgRecheckMonths of it, board-configured), bgClearedAt is stamped
 * and signing alone opens payment; otherwise the member requests a new background
 * check on Averity and the 2-of-N review runs in parallel with payment, exactly
 * like INITIAL. No auto-revoke — manual admin action. RENEWAL_PENDING_BG is legacy:
 * nothing writes it anymore (a migration moved open rows to the request flow).
 */


/**
 * A household application that stops another from starting: one in flight (one
 * open household application at a time), or a BLOCKED one, which only the board
 * moves on (reset or override).
 */
export const householdApplicationOpenOrBlockedWhere: Prisma.OrgMembershipProcessWhereInput = {
    OR: [
        { kind: "INITIAL", status: { in: [...IN_FLIGHT_INITIAL] } },
        { kind: "RENEWAL", status: { in: [...IN_FLIGHT_RENEWAL] } },
        { kind: { in: ["INITIAL", "RENEWAL"] }, status: "BLOCKED" },
    ],
};

export class RenewalError extends ServiceError {
    constructor(public readonly code: "not_found" | "wrong_phase" | "not_lead" | "denied" | "blocked", message: string) {
        super(RENEWAL_ERROR_STATUS[code], message, code);
        this.name = "RenewalError";
    }
}


// Mirrors monthsBefore exactly — raw JS month arithmetic, UTC, no end-of-month
// clamping (JS rolls over: Jan 31 + 1mo -> Mar 2/3). Consistency with
// bgFreshThreshold's math matters more than calendar prettiness, and
// the boundary is an admin-set day (e.g. Aug 1) in practice.
function monthsAfter(date: Date, months: number): Date {
    const d = new Date(date);
    d.setUTCMonth(d.getUTCMonth() + months);
    return d;
}

/**
 * Background-check "valid until": the boundary occurrence that follows raw expiry
 * (lastBackgroundCheck + bgRecheckMonths months). Null when there's no check on
 * file, the recheck policy isn't set, or no boundary is configured. Pure — no
 * prisma — so it composes over both a single member and a household's later lead.
 */
export function bgValidUntilBoundary(
    lastBackgroundCheck: Date | null,
    settings: { orgMembershipYearBoundary: Date | null; bgRecheckMonths: number },
): Date | null {
    if (!lastBackgroundCheck || !isRecheckPolicySet(settings.bgRecheckMonths) || !settings.orgMembershipYearBoundary) {
        return null;
    }
    const rawExpiry = monthsAfter(lastBackgroundCheck, settings.bgRecheckMonths);
    // Truncate to the raw expiry's UTC day before asking nextBoundary. nextBoundary
    // compares full timestamps with a strict `<`; lastBackgroundCheck carries a
    // time-of-day, so without truncation a raw expiry landing ON the boundary day
    // (e.g. Aug 1 14:32) would skip to NEXT year's boundary. Policy (matches
    // the check standing's `>=` threshold): a check expiring on the boundary day
    // still covers that boundary → return that same occurrence.
    const rawExpiryDay = new Date(Date.UTC(rawExpiry.getUTCFullYear(), rawExpiry.getUTCMonth(), rawExpiry.getUTCDate()));
    return nextBoundary(settings.orgMembershipYearBoundary, rawExpiryDay);
}



/**
 * How far a household's membership fee reaches in the live cycle: the boundary that closes it
 * when the household settled for it, else the boundary that opened it — which is
 * already past off season, so an un-renewed household reads as lapsed from the
 * boundary on. Status is untouched; only a person revokes.
 */
export function coveredThrough(cycle: { cycleStart: Date; cycleEnd: Date }, settled: boolean): Date {
    return settled ? cycle.cycleEnd : cycle.cycleStart;
}

/**
 * Compute the settled-since window for a specific year label (e.g. "2025-2026").
 * Returns settledSince as membershipYearCycle does, for an arbitrary cycle, plus an
 * upper bound so historical queries don't leak into later cycles.
 */
export function membershipYearCycleForLabel(
    configuredBoundary: Date,
    label: string,
): { label: string; settledSince: Date; settledBefore: Date } | null {
    const match = label.match(/^(\d{4})-(\d{4})$/);
    if (!match) return null;
    const startYear = parseInt(match[1], 10);
    const endYear = parseInt(match[2], 10);
    if (endYear !== startYear + 1) return null;
    const bMonth = configuredBoundary.getUTCMonth();
    const bDay = configuredBoundary.getUTCDate();
    const settledSince = monthsBefore(new Date(Date.UTC(startYear, bMonth, bDay)), RENEWAL_LEAD_MONTHS);
    const settledBefore = monthsBefore(new Date(Date.UTC(endYear, bMonth, bDay)), RENEWAL_LEAD_MONTHS);
    return { label, settledSince, settledBefore };
}

/**
 * Open renewal processes for every ACTIVE membership, inside the lead window only
 * and only while the coming year has a product to pay through, unless the
 * household was already handled this cycle. Backs the board's
 * "Open renewals" button, the only way renewals start. Returns a summary.
 */
export async function runRenewalSweep(now: Date) {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    if (!settings?.orgMembershipYearBoundary) {
        return { opened: 0, skipped: 0, reason: "no membership-year boundary configured" };
    }

    const today = await orgToday(now);
    const { boundary, windowStart, inSeason } = renewalWindow(settings.orgMembershipYearBoundary, today);
    if (!inSeason) {
        return { opened: 0, skipped: 0, reason: "not yet within renewal window" };
    }

    // In season the live year is the coming year. Lazy: payment.ts imports this module.
    const comingYear = membershipYearCycle(settings.orgMembershipYearBoundary, today).cycleStart.getUTCFullYear();
    const { yearVariantId } = await import("@/lib/membership/payment");
    if (!(await yearVariantId(comingYear))) {
        return { opened: 0, skipped: 0, reason: `no membership product set for ${membershipYearLabel(comingYear)}` };
    }

    const memberships = await prisma.orgMembership.findMany({
        where: { status: "ACTIVE" },
        // "Handled this cycle" = an in-flight RENEWAL by status (matches the partial
        // unique index), OR handledThisCycleWhere: an ACTIVE process that bought the
        // live year (opening a renewal would bill them twice), or a board archive
        // in-window (already looked at — reopening would pester a family the board
        // just declined). ARCHIVED counts HERE only; money horizons use the narrower
        // settledThisCycleWhere.
        select: {
            id: true,
            processes: {
                where: {
                    OR: [
                        { kind: "RENEWAL", status: { in: [...IN_FLIGHT_RENEWAL] } },
                        handledThisCycleWhere(comingYear, windowStart),
                    ],
                },
                select: { id: true },
            },
        },
    });

    let opened = 0;
    let skipped = 0;
    for (const m of memberships) {
        if (m.processes.length > 0) { skipped++; continue; } // already opened this cycle
        const p = await createRenewalProcess(m.id, comingYear);
        if (p) opened++; else skipped++; // null = concurrent run beat us to it
    }

    return { opened, skipped, boundary: boundary.toISOString() };
}

/**
 * Member begins renewal: PENDING_RENEWAL -> PENDING_EXTERNAL_ACTION, always — a
 * fresh membership agreement is signed every cycle. The household is then settled
 * on its people's checks: one that qualifies is pre-cleared so only the signature
 * is left, one with a disputed adult is blocked, and otherwise the member also
 * requests a new background check, same flow as INITIAL. Only acts from
 * PENDING_RENEWAL. Refused for a DENIED household (raised to the board) or one
 * with a BLOCKED application; the status read and the CAS share a lock on the
 * Membership row, so a concurrent deny serializes against it.
 */
export async function beginRenewal(processId: number, actorId: number) {
    const process = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
    if (!process) throw new RenewalError("not_found", "Renewal not found.");
    if (process.status !== "PENDING_RENEWAL") throw new RenewalError("wrong_phase", "This renewal is not awaiting your confirmation.");

    const { orgMembershipId } = asHouseholdProcess(process);
    const membership = await prisma.orgMembership.findUnique({
        where: { id: orgMembershipId },
        select: { householdId: true },
    });
    if (!membership) throw new RenewalError("not_found", "Membership not found.");

    const outcome = await prisma.$transaction(async (tx) => {
        // Membership, then application: the order lib/lockOrder.ts states.
        const [locked] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM "OrgMembership" WHERE id = ${orgMembershipId} FOR UPDATE`;
        await lockProcessRows(tx, [processId]);
        if (locked?.status === "DENIED") return "denied" as const;
        const blocked = await tx.orgMembershipProcess.findFirst({
            where: { orgMembershipId, kind: { in: ["INITIAL", "RENEWAL"] }, status: "BLOCKED" },
            select: { id: true },
        });
        if (blocked) return "blocked" as const;

        // CAS on PENDING_RENEWAL: of two double-submits only the winner flips it, so
        // the audit row is written exactly once.
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id: processId, ...fromWhere("PENDING_RENEWAL") },
            data: { status: "PENDING_EXTERNAL_ACTION", stageEnteredAt: new Date() },
        });
        if (count === 1) {
            await tx.auditLog.create({
                data: { ...personActor(actorId), action: "EDIT", tableName: "OrgMembershipProcess", affectedEntityId: processId, oldData: { status: "PENDING_RENEWAL" }, newData: { status: "PENDING_EXTERNAL_ACTION" } },
            });
            // Confirming the renewal takes back a "won't renew" note.
            await clearNotRenewingInTx(tx, orgMembershipId, actorId);
        }
        return count === 1 ? ("moved" as const) : null;
    });
    if (outcome === "denied") {
        await raiseDeniedHouseholdActivity({ householdId: membership.householdId, processId, personId: actorId, what: "beginRenewal refused" });
        throw new RenewalError("denied", "Your household can't renew. Please contact the board.");
    }
    if (outcome === "blocked") {
        throw new RenewalError("blocked", "Your household's application is with the board. Please contact the board.");
    }
    // Lazy, like external.ts below: settle pulls in the review and payment modules.
    if (outcome === "moved") {
        const { settleAfterEvent } = await import("@/lib/membership/settleHouseholdBg");
        await settleAfterEvent(membership.householdId, "renewal", {}, { processId });
    }

    // The gate can already be met on arrival (bgClearedAt stamped by settle, a board
    // pre-mark of contractSignedAt, or a lead's check already started), so re-run the advance; it is a
    // no-op when the external actions aren't done. Lazy: external.ts pulls in the
    // agreement PDF and S3 client, and renewal.ts is imported across the app.
    const { advanceExternalIfComplete } = await import("@/lib/membership/external");
    return (await advanceExternalIfComplete(processId)) ?? prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: processId } });
}

/**
 * Create one PENDING_RENEWAL process (+ audit) for membership year `membershipYear`
 * for an ACTIVE household, or no-op
 * when the household is no longer ACTIVE or already has an open or BLOCKED
 * household application ({@link householdApplicationOpenOrBlockedWhere}).
 * The callers' check-then-act is NOT atomic, so this function serializes its own
 * check+insert by locking the parent Membership row (SELECT ... FOR UPDATE): a
 * concurrent sweep/admin-button/double-click blocks until the winner commits, then
 * sees the winner's in-flight process and returns null — no duplicate audit row.
 * This holds in every environment, not just one provisioned via `migrate deploy`
 * (the partial unique index `membership_one_inflight_renewal` is migration-only —
 * `prisma db push` and the integration test DBs don't have it). The index stays as
 * defense-in-depth and the P2002 catch as a backstop. Returns null when this call
 * lost the race.
 *
 * Never emails — the machine (sweep, board button) never sends a reminder; the
 * settings/outreach page is the only send surface (see lib/outreach). householdId/now/
 * boundary dropped from the signature (#PR-2) along with the reminder they only existed
 * to feed — renewalReminderSentAt is now write-never (column kept, see its schema doc).
 */
export async function createRenewalProcess(orgMembershipId: number, membershipYear: number) {
    let process;
    try {
        process = await prisma.$transaction(async (tx) => {
            // Lock the membership row so overlapping opens serialize here, not at the INSERT.
            const [locked] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM "OrgMembership" WHERE id = ${orgMembershipId} FOR UPDATE`;
            if (locked?.status !== "ACTIVE") return null;
            const existing = await tx.orgMembershipProcess.findFirst({
                where: { orgMembershipId, ...householdApplicationOpenOrBlockedWhere },
                select: { id: true },
            });
            if (existing) return null;
            const created = await tx.orgMembershipProcess.create({
                data: { orgMembershipId, kind: "RENEWAL", status: "PENDING_RENEWAL", membershipYear },
            });
            await tx.auditLog.create({
                data: { ...systemActor("system:renewal-open"), action: "CREATE", tableName: "OrgMembershipProcess", affectedEntityId: created.id, newData: { kind: "RENEWAL", status: "PENDING_RENEWAL", membershipYear } },
            });
            return created;
        });
    } catch (e) {
        if (isPrismaError(e, "P2002")) {
            logger.info("Renewal already in flight for membership %d — concurrent open, skipping", orgMembershipId);
            return null;
        }
        throw e;
    }
    if (!process) {
        logger.info("Renewal not opened for membership %d — not ACTIVE, or an application is already open or blocked", orgMembershipId);
        return null;
    }
    return process;
}

/** Resolve and begin the caller's household renewal. Lead-gated like every
 *  other membership action (intake assertLead): confirming a renewal advances
 *  the household's membership state, which is the lead's call — a non-lead
 *  member (incl. youth logins) must not be able to trigger it. */
export async function beginRenewalForUser(userId: number) {
    const user = await prisma.person.findUnique({
        where: { id: userId },
        select: { householdId: true, isHouseholdLead: true, isSysadmin: true },
    });
    if (!user?.householdId) throw new RenewalError("not_found", "You are not in a household.");
    if (!user.isHouseholdLead && !user.isSysadmin) {
        throw new RenewalError("not_lead", "Only a household lead can confirm the renewal.");
    }
    const process = await prisma.orgMembershipProcess.findFirst({
        where: { orgMembership: { householdId: user.householdId }, status: "PENDING_RENEWAL" },
        orderBy: { id: "desc" },
    });
    if (!process) throw new RenewalError("wrong_phase", "No renewal is awaiting your confirmation.");
    return beginRenewal(process.id, userId);
}

/** The earliest check date still valid at the boundary, or null under an unset policy. */
export function bgFreshThreshold(boundary: Date | null, recheckMonths: number | null | undefined): Date | null {
    if (!isRecheckPolicySet(recheckMonths) || !boundary) return null;
    return monthsBefore(boundary, recheckMonths);
}

/** The earliest check date still valid at the start of membership year `year`, or null when any input is unset. */
export function bgThresholdForYear(boundary: Date | null, recheckMonths: number | null | undefined, year: number | null): Date | null {
    return boundary && year != null ? bgFreshThreshold(membershipYearStart(boundary, year), recheckMonths) : null;
}
