import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import { isPrismaError } from "@/lib/prismaUniqueViolation";
import { logger } from "@/lib/logger";
import { certifyPaymentPlan, PaymentError } from "./payment";
import { IN_FLIGHT_INITIAL, IN_FLIGHT_RENEWAL, grantableRenewalWhere, handledThisCycleWhere, fromWhere } from "@/lib/membership/lifecycle";
import { raiseDeniedHouseholdActivity } from "@/lib/membership/householdStatus";
import { LIVE_PERSON } from "@/lib/person/filters";
import { personActor, systemActor } from "@/lib/auditActor";
import { isRecheckPolicySet } from "@/lib/membership/bgRecheckPolicy";

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

const RENEWAL_LEAD_MONTHS = 2;

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

export class RenewalError extends Error {
    constructor(public readonly code: "not_found" | "wrong_phase" | "not_lead" | "denied" | "blocked", message: string) {
        super(message);
        this.name = "RenewalError";
    }
}

/** The next occurrence (>= now) of the boundary's month/day. */
export function nextBoundary(boundary: Date, now: Date): Date {
    const b = new Date(Date.UTC(now.getUTCFullYear(), boundary.getUTCMonth(), boundary.getUTCDate()));
    if (b.getTime() < now.getTime()) b.setUTCFullYear(b.getUTCFullYear() + 1);
    return b;
}

export function monthsBefore(date: Date, months: number): Date {
    const d = new Date(date);
    d.setUTCMonth(d.getUTCMonth() - months);
    return d;
}

// Mirrors monthsBefore exactly — raw JS month arithmetic, UTC, no end-of-month
// clamping (JS rolls over: Jan 31 + 1mo -> Mar 2/3). Consistency with
// householdBgIsFresh's threshold math matters more than calendar prettiness, and
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
    // householdBgIsFresh's `gte` threshold): a check expiring on the boundary day
    // still covers that boundary → return that same occurrence.
    const rawExpiryDay = new Date(Date.UTC(rawExpiry.getUTCFullYear(), rawExpiry.getUTCMonth(), rawExpiry.getUTCDate()));
    return nextBoundary(settings.orgMembershipYearBoundary, rawExpiryDay);
}

/**
 * Off-season / boundary-unset sentinel. Every caller reads the same shape —
 * `stageEnteredAt: { gte: window?.windowStart ?? MAX_DATE }` — where "no window"
 * must match nobody rather than everybody. Named once here, beside the window
 * functions that return the null it stands in for.
 */
export const MAX_DATE = new Date(8.64e15);

/**
 * From a configured boundary date, the next boundary occurrence and whether `now`
 * sits inside the renewal lead window before it. Pure; the single source of the
 * "are we in renewal season" calc shared by runRenewalSweep and isRenewalSeason.
 */
export function renewalWindow(configuredBoundary: Date, now: Date): { boundary: Date; windowStart: Date; inSeason: boolean } {
    const boundary = nextBoundary(configuredBoundary, now);
    const windowStart = monthsBefore(boundary, RENEWAL_LEAD_MONTHS);
    return { boundary, windowStart, inSeason: now.getTime() >= windowStart.getTime() };
}

/**
 * The membership year now in effect: its label, the boundary that opened it
 * (`cycleStart`), the boundary that closes it (`cycleEnd`), and the date a household
 * must have settled on or after to have bought it (`settledSince`). The year flips
 * at windowStart — the coming year becomes "live" exactly when it becomes renewable
 * and stays live until the next window opens — so in season the live year is the
 * one about to begin, and off season it is the one that began at the last boundary.
 * Drives badge years and every money horizon; pure, from the configured boundary.
 */
export function membershipYearCycle(
    configuredBoundary: Date,
    now: Date,
): { label: string; settledSince: Date; cycleStart: Date; cycleEnd: Date } {
    const { boundary, windowStart, inSeason } = renewalWindow(configuredBoundary, now);
    // Off-season, `boundary` is already next year's, so the live cycle is the one that
    // opened at the previous windowStart.
    const endYear = boundary.getUTCFullYear() + (inSeason ? 1 : 0);
    const settledSince = inSeason
        ? windowStart
        : new Date(Date.UTC(windowStart.getUTCFullYear() - 1, windowStart.getUTCMonth(), windowStart.getUTCDate()));
    const cycleEnd = new Date(Date.UTC(endYear, boundary.getUTCMonth(), boundary.getUTCDate()));
    const cycleStart = new Date(Date.UTC(endYear - 1, boundary.getUTCMonth(), boundary.getUTCDate()));
    return { label: `${endYear - 1}-${endYear}`, settledSince, cycleStart, cycleEnd };
}

/** The live year at `now`, named by the year its opening boundary is in; null with no boundary set. */
export function liveMembershipYear(configuredBoundary: Date | null | undefined, now: Date): number | null {
    return configuredBoundary ? membershipYearCycle(configuredBoundary, now).cycleStart.getUTCFullYear() : null;
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
 * True when `now` sits inside the renewal lead window before the configured
 * boundary — the same window runRenewalSweep opens/reminds on. No boundary set
 * ⇒ not renewal season. Drives the admin "Grant for coming year" button.
 */
export async function isRenewalSeason(now: Date): Promise<boolean> {
    return (await renewalSeasonWindow(now)) !== null;
}

/**
 * The live renewal window when `now` is inside it, else null. Callers that need
 * the window bounds (e.g. "was this cycle already resolved?") use this instead of
 * re-reading BoardSettings themselves.
 */
export async function renewalSeasonWindow(now: Date): Promise<{ boundary: Date; windowStart: Date } | null> {
    const settings = await prisma.boardSettings.findUnique({
        where: { id: 1 },
        select: { orgMembershipYearBoundary: true },
    });
    if (!settings?.orgMembershipYearBoundary) return null;
    const { boundary, windowStart, inSeason } = renewalWindow(settings.orgMembershipYearBoundary, now);
    return inSeason ? { boundary, windowStart } : null;
}

/**
 * Open renewal processes for every ACTIVE membership, inside the lead window only,
 * unless the household was already handled this cycle. Backs the board's
 * "Open renewals" button, the only way renewals start. Returns a summary.
 */
export async function runRenewalSweep(now: Date) {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    if (!settings?.orgMembershipYearBoundary) {
        return { opened: 0, skipped: 0, reason: "no membership-year boundary configured" };
    }

    const { boundary, windowStart, inSeason } = renewalWindow(settings.orgMembershipYearBoundary, now);
    if (!inSeason) {
        return { opened: 0, skipped: 0, reason: "not yet within renewal window" };
    }

    const memberships = await prisma.orgMembership.findMany({
        where: { status: "ACTIVE" },
        // "Handled this cycle" = an in-flight RENEWAL by status (matches the partial
        // unique index), OR any process terminal in-window
        // (handledThisCycleWhere): a finished renewal, the "Grant for coming year"
        // override, an INITIAL that activated inside the window (that family just
        // bought the coming year; opening a renewal would bill them twice), or a
        // board archive (already looked at — reopening would pester a family the
        // board just declined). ARCHIVED counts HERE only; money horizons use the
        // narrower settledThisCycleWhere.
        select: {
            id: true,
            processes: {
                where: {
                    OR: [
                        { kind: "RENEWAL", status: { in: [...IN_FLIGHT_RENEWAL] } },
                        handledThisCycleWhere(windowStart),
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
        const p = await createRenewalProcess(m.id);
        if (p) opened++; else skipped++; // null = concurrent run beat us to it
    }

    return { opened, skipped, boundary: boundary.toISOString() };
}

/**
 * Member begins renewal: PENDING_RENEWAL -> PENDING_EXTERNAL_ACTION, always — a
 * fresh membership agreement is signed every cycle. A still-valid background
 * check is pre-cleared so only the signature is left; otherwise the member also
 * requests a new background check, same flow as INITIAL. Only acts from
 * PENDING_RENEWAL. Refused for a DENIED household (raised to the board) or one
 * with a BLOCKED application; the status read and the CAS share a lock on the
 * Membership row, so a concurrent deny serializes against it.
 */
export async function beginRenewal(processId: number, actorId: number) {
    const process = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
    if (!process) throw new RenewalError("not_found", "Renewal not found.");
    if (process.status !== "PENDING_RENEWAL") throw new RenewalError("wrong_phase", "This renewal is not awaiting your confirmation.");

    // A RENEWAL always has a membership (orgMembershipId is only null for PERSON_BG).
    const orgMembershipId = process.orgMembershipId!;
    const membership = await prisma.orgMembership.findUnique({
        where: { id: orgMembershipId },
        select: { householdId: true },
    });
    if (!membership) throw new RenewalError("not_found", "Membership not found.");
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    const boundary = settings?.orgMembershipYearBoundary ? nextBoundary(settings.orgMembershipYearBoundary, new Date()) : null;

    // A still-valid background check ⇒ stamp bgClearedAt now: the external card
    // shows "no new background check needed" and the signature alone opens
    // payment. Reviewers are pinged by the advance, once consent is recorded.
    const clearNow = await householdBgIsFresh(membership.householdId, boundary, settings?.bgRecheckMonths);

    const refusal = await prisma.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM "OrgMembership" WHERE id = ${orgMembershipId} FOR UPDATE`;
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
            data: { status: "PENDING_EXTERNAL_ACTION", stageEnteredAt: new Date(), ...(clearNow ? { bgClearedAt: new Date() } : {}) },
        });
        if (count === 1) {
            await tx.auditLog.create({
                data: { ...personActor(actorId), action: "EDIT", tableName: "OrgMembershipProcess", affectedEntityId: processId, oldData: { status: "PENDING_RENEWAL" }, newData: { status: "PENDING_EXTERNAL_ACTION", ...(clearNow ? { bgClearedAt: true } : {}) } },
            });
        }
        return null;
    });
    if (refusal === "denied") {
        await raiseDeniedHouseholdActivity({ householdId: membership.householdId, processId, personId: actorId, what: "beginRenewal refused" });
        throw new RenewalError("denied", "Your household can't renew. Please contact the board.");
    }
    if (refusal === "blocked") {
        throw new RenewalError("blocked", "Your household's application is with the board. Please contact the board.");
    }

    // The gate can already be met on arrival (bgClearedAt stamped above, or a board
    // pre-mark of contractSignedAt/bgConsentAt), so re-run the advance; it is a
    // no-op when the external actions aren't done. Lazy: external.ts pulls in the
    // agreement PDF and S3 client, and renewal.ts is imported across the app.
    const { advanceExternalIfComplete } = await import("@/lib/membership/external");
    return (await advanceExternalIfComplete(processId)) ?? prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: processId } });
}

/**
 * Create one PENDING_RENEWAL process (+ audit) for an ACTIVE household, or no-op
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
export async function createRenewalProcess(orgMembershipId: number) {
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
                data: { orgMembershipId, kind: "RENEWAL", status: "PENDING_RENEWAL" },
            });
            await tx.auditLog.create({
                data: { ...systemActor("system:renewal-open"), action: "CREATE", tableName: "OrgMembershipProcess", affectedEntityId: created.id, newData: { kind: "RENEWAL", status: "PENDING_RENEWAL" } },
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

/**
 * True if EITHER guardian (household lead) has a background check still valid at the boundary,
 * i.e. lastBackgroundCheck >= boundary - recheckMonths. Unset policy — recheckMonths 0 or a
 * null boundary (no membership year configured) — means nothing counts as fresh; renewals
 * re-run review rather than measuring freshness against an invented boundary.
 */
export async function householdBgIsFresh(householdId: number, boundary: Date | null, recheckMonths: number | null | undefined): Promise<boolean> {
    if (!isRecheckPolicySet(recheckMonths) || !boundary) return false;
    const threshold = monthsBefore(boundary, recheckMonths);
    const fresh = await prisma.person.findFirst({
        where: { householdId, isHouseholdLead: true, lastBackgroundCheck: { gte: threshold }, ...LIVE_PERSON },
        select: { id: true },
    });
    return fresh !== null;
}

/**
 * Admin "Grant for coming year": comp the payment gate on a household's
 * in-flight RENEWAL that's at PENDING_PAYMENT (contract signed) — via the same
 * settlement path a real payment takes. This comps PAYMENT ONLY; it never
 * bypasses the background-check gate. A row whose BG is already cleared
 * (bgClearedAt set) settles straight to ACTIVE; a parallel-track row (BG still
 * in review, bgConsentAt set, bgClearedAt null) settles to PENDING_BG_CLEARANCE
 * and stays INACTIVE until reviewers clear it — exactly what a real payment on
 * that row does (see activate()'s `activating = !!bgClearedAt`).
 *
 * Any PENDING_PAYMENT renewal has bgClearedAt OR bgConsentAt set
 * (advanceExternalIfComplete won't advance without one), so comping here can
 * never skip review. Never archives, never stamps a gate, never creates a process.
 */
export async function grantRenewalPayment(
    householdId: number,
    actor: { actorId: number; reason: string },
): Promise<import("@/generated/prisma/client").OrgMembershipProcess> {
    // Share the "payable renewal" predicate with the list route's renewalGrantable
    // probe (fix #3, grantableRenewalWhere): kind=RENEWAL, PENDING_PAYMENT — NOT
    // bg-gated, so the button's query and this lookup agree on which rows qualify.
    // No bgClearedAt/bgFresh gate here: the grant comps payment and BG stays an
    // independent gate on ACTIVE (parallel-track rows settle to PENDING_BG_CLEARANCE).
    const process = await prisma.orgMembershipProcess.findFirst({
        where: { orgMembership: { householdId }, ...grantableRenewalWhere },
        orderBy: { id: "desc" },
    });
    if (!process) throw new PaymentError("wrong_phase", "No renewal is awaiting payment.");

    // COI is enforced INSIDE certifyPaymentPlan (single source): certifying your own
    // household throws PaymentError('forbidden'), whatever roles you hold.
    await certifyPaymentPlan(process.id, actor.actorId, { reason: actor.reason });

    // Supplementary audit marker (traceability) — the PENDING_PAYMENT→ACTIVE
    // transition itself is already audited inside activate().
    await prisma.auditLog.create({
        data: {
            actorId: actor.actorId,
            action: "EDIT",
            tableName: "OrgMembershipProcess",
            affectedEntityId: process.id,
            secondaryAffectedEntity: householdId,
            newData: { comingYearGrant: true, reason: actor.reason },
        },
    });

    return prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: process.id } });
}
