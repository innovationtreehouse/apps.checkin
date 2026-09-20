/**
 * @jest-environment node
 */
/**
 * Unit tests for renewal.ts edge logic (prisma mocked, no DB):
 *   - householdBgIsFresh: the unset-policy short-circuits (recheckMonths<=0, null
 *     boundary), and the `gte` threshold boundary (a background check exactly at
 *     the threshold counts as fresh).
 *   - beginRenewal: a process not in PENDING_RENEWAL → RenewalError wrong_phase;
 *     every path lands at PENDING_EXTERNAL_ACTION (a fresh agreement is signed
 *     each cycle) and only a still-valid background check with no household
 *     note pre-stamps bgClearedAt.
 */
import { householdBgIsFresh, beginRenewal, isRenewalSeason, RenewalError, bgValidUntilBoundary, membershipYearCycle, membershipYearCycleForLabel, coveredThrough, runRenewalSweep } from '@/lib/membership/renewal';
import { IN_FLIGHT_RENEWAL, handledThisCycleWhere } from '@/lib/membership/lifecycle';

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        person: { findFirst: jest.fn() },
        orgMembershipProcess: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), updateMany: jest.fn() },
        orgMembership: { findUnique: jest.fn(), findMany: jest.fn() },
        boardSettings: { findUnique: jest.fn() },
        auditLog: { create: jest.fn() },
    },
}));

jest.mock('@/lib/membership/review', () => ({
    notifyReviewers: jest.fn().mockResolvedValue(undefined),
    applyVolunteerStatus: jest.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const prisma = require('@/lib/prisma').default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { notifyReviewers, applyVolunteerStatus } = require('@/lib/membership/review');

// Mirrors the module-private monthsBefore in renewal.ts.
function monthsBefore(date: Date, months: number): Date {
    const d = new Date(date);
    d.setUTCMonth(d.getUTCMonth() - months);
    return d;
}

beforeEach(() => jest.clearAllMocks());

describe('householdBgIsFresh', () => {
    const boundary = new Date(Date.UTC(2026, 8, 1)); // 2026-09-01

    it('recheckMonths = 0 → not fresh, and never queries (policy unset)', async () => {
        // Even a recent background check on file must not count when the board hasn't set the policy.
        prisma.person.findFirst.mockResolvedValue({ id: 1 });

        const result = await householdBgIsFresh(42, boundary, 0);

        expect(result).toBe(false);
        expect(prisma.person.findFirst).not.toHaveBeenCalled();
    });

    it('no boundary → not fresh, and never queries (membership year unset)', async () => {
        // An unset boundary must not become "now": that would measure freshness against
        // a boundary the board never configured and hand out the shortcut.
        prisma.person.findFirst.mockResolvedValue({ id: 1 });

        const result = await householdBgIsFresh(42, null, 12);

        expect(result).toBe(false);
        expect(prisma.person.findFirst).not.toHaveBeenCalled();
    });

    it('a lead with a background check at exactly the threshold → fresh (gte boundary)', async () => {
        prisma.person.findFirst.mockResolvedValue({ id: 1 });

        const result = await householdBgIsFresh(42, boundary, 12);

        expect(result).toBe(true);
        // The boundary is inclusive (gte), and the threshold is boundary - recheckMonths.
        expect(prisma.person.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    householdId: 42,
                    lastBackgroundCheck: { gte: monthsBefore(boundary, 12) },
                }),
            }),
        );
    });

    it('no lead with a fresh-enough background check → not fresh', async () => {
        prisma.person.findFirst.mockResolvedValue(null);
        expect(await householdBgIsFresh(42, boundary, 12)).toBe(false);
    });
});

describe('bgValidUntilBoundary', () => {
    const boundary = new Date(Date.UTC(2000, 7, 1)); // Aug 1 (year ignored — month/day only)
    const settings = { orgMembershipYearBoundary: boundary, bgRecheckMonths: 12 };

    it('mid-cycle check: raw expiry a year later, well before Aug 1 → that Aug 1 occurrence', () => {
        const last = new Date(Date.UTC(2026, 0, 15, 10, 0)); // 2026-01-15T10:00Z
        expect(bgValidUntilBoundary(last, settings)).toEqual(new Date(Date.UTC(2027, 7, 1)));
    });

    it('expiry exactly on the boundary day (>= edge, time-of-day truncated) → same day, not next year', () => {
        const last = new Date(Date.UTC(2026, 7, 1, 14, 32)); // 2026-08-01T14:32Z -> raw expiry 2027-08-01T14:32Z
        expect(bgValidUntilBoundary(last, settings)).toEqual(new Date(Date.UTC(2027, 7, 1)));
    });

    it('late-in-year check whose raw expiry crosses the boundary → next year\'s boundary', () => {
        const last = new Date(Date.UTC(2026, 10, 20)); // 2026-11-20 -> raw expiry 2027-11-20, past Aug 1 2027
        expect(bgValidUntilBoundary(last, settings)).toEqual(new Date(Date.UTC(2028, 7, 1)));
    });

    it('bgRecheckMonths = 0 → null (policy unset)', () => {
        const last = new Date(Date.UTC(2026, 0, 15));
        expect(bgValidUntilBoundary(last, { ...settings, bgRecheckMonths: 0 })).toBeNull();
    });

    it('lastBackgroundCheck = null → null', () => {
        expect(bgValidUntilBoundary(null, settings)).toBeNull();
    });

    it('orgMembershipYearBoundary = null → null', () => {
        const last = new Date(Date.UTC(2026, 0, 15));
        expect(bgValidUntilBoundary(last, { ...settings, orgMembershipYearBoundary: null })).toBeNull();
    });
});

describe('membershipYearCycle', () => {
    // Sep 1 boundary (year ignored — month/day only), so the lead window opens Jul 1.
    const boundary = new Date(Date.UTC(2000, 8, 1));

    // One flip per year, at windowStart, and continuous across the boundary itself:
    // every date in a cycle reports the same label and the same settledSince.
    it.each([
        ['in season, before the boundary', Date.UTC(2026, 7, 10), '2026-2027', Date.UTC(2026, 6, 1)],
        ['just past the boundary', Date.UTC(2026, 8, 15), '2026-2027', Date.UTC(2026, 6, 1)],
        ['deep off-season, next spring', Date.UTC(2027, 5, 15), '2026-2027', Date.UTC(2026, 6, 1)],
        ['the next window opens', Date.UTC(2027, 6, 15), '2027-2028', Date.UTC(2027, 6, 1)],
    ])('%s', (_label, now, expectedLabel, expectedSettledSince) => {
        const [startYear, endYear] = expectedLabel.split('-').map(Number);
        expect(membershipYearCycle(boundary, new Date(now))).toEqual({
            label: expectedLabel,
            settledSince: new Date(expectedSettledSince),
            cycleStart: new Date(Date.UTC(startYear, 8, 1)),
            cycleEnd: new Date(Date.UTC(endYear, 8, 1)),
        });
    });

    // The money horizon: settled ⇒ the boundary closing the live year; not settled ⇒
    // the one that opened it — so an un-renewed household reads as lapsed the day
    // after the boundary instead of rolling forward a year.
    it('coveredThrough: settled reaches cycleEnd, unsettled stops at cycleStart', () => {
        const cycle = membershipYearCycle(boundary, new Date(Date.UTC(2026, 8, 15)));
        expect(coveredThrough(cycle, true)).toEqual(new Date(Date.UTC(2027, 8, 1)));
        expect(coveredThrough(cycle, false)).toEqual(new Date(Date.UTC(2026, 8, 1)));
    });

    it('flips on the day the window opens, not the day before', () => {
        expect(membershipYearCycle(boundary, new Date(Date.UTC(2027, 5, 30))).label).toBe('2026-2027');
        expect(membershipYearCycle(boundary, new Date(Date.UTC(2027, 6, 1))).label).toBe('2027-2028');
    });
});

describe('membershipYearCycleForLabel', () => {
    // Sep 1 boundary — settledSince = boundary - 2 months = Jul 1 of the start year.
    const boundary = new Date(Date.UTC(2000, 8, 1));

    it.each([
        ['in-season label', '2026-2027', Date.UTC(2026, 6, 1), Date.UTC(2027, 6, 1)],
        ['off-season label', '2025-2026', Date.UTC(2025, 6, 1), Date.UTC(2026, 6, 1)],
        ['early label', '2023-2024', Date.UTC(2023, 6, 1), Date.UTC(2024, 6, 1)],
        ['future label', '2028-2029', Date.UTC(2028, 6, 1), Date.UTC(2029, 6, 1)],
    ])('%s', (_desc, label, expectedSince, expectedBefore) => {
        const result = membershipYearCycleForLabel(boundary, label);
        expect(result).toEqual({
            label,
            settledSince: new Date(expectedSince),
            settledBefore: new Date(expectedBefore),
        });
    });

    it('agrees with membershipYearCycle for the current cycle (in-season)', () => {
        const now = new Date(Date.UTC(2026, 7, 10));
        const live = membershipYearCycle(boundary, now);
        const fromLabel = membershipYearCycleForLabel(boundary, live.label)!;
        expect(fromLabel.settledSince).toEqual(live.settledSince);
    });

    it('agrees with membershipYearCycle for the current cycle (off-season)', () => {
        const now = new Date(Date.UTC(2027, 3, 15));
        const live = membershipYearCycle(boundary, now);
        const fromLabel = membershipYearCycleForLabel(boundary, live.label)!;
        expect(fromLabel.settledSince).toEqual(live.settledSince);
    });

    it('rejects malformed labels', () => {
        expect(membershipYearCycleForLabel(boundary, 'abc')).toBeNull();
        expect(membershipYearCycleForLabel(boundary, '2026')).toBeNull();
        expect(membershipYearCycleForLabel(boundary, '2026-2028')).toBeNull();
    });
});

describe('isRenewalSeason', () => {
    // Boundary month/day = Sep 1; lead window is 2 months → season opens Jul 1.
    const boundaryConfig = new Date(Date.UTC(2020, 8, 1)); // year is ignored (month/day only)

    it('no boundary configured → not renewal season', async () => {
        prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: null });
        expect(await isRenewalSeason(new Date(Date.UTC(2026, 7, 15)))).toBe(false);
    });

    it('inside the 2-month lead window → renewal season', async () => {
        prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: boundaryConfig });
        // 2026-08-01 is within [2026-07-01, 2026-09-01).
        expect(await isRenewalSeason(new Date(Date.UTC(2026, 7, 1)))).toBe(true);
    });

    it('before the lead window opens → not renewal season', async () => {
        prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: boundaryConfig });
        // 2026-06-30 is one day before the window opens.
        expect(await isRenewalSeason(new Date(Date.UTC(2026, 5, 30)))).toBe(false);
    });
});

describe('beginRenewal', () => {
    it('throws RenewalError wrong_phase when the process is not PENDING_RENEWAL', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ id: 5, status: 'PENDING_PAYMENT', orgMembershipId: 9 });

        await expect(beginRenewal(5, 42)).rejects.toMatchObject({
            name: 'RenewalError',
            code: 'wrong_phase',
        });
        await expect(beginRenewal(5, 42)).rejects.toBeInstanceOf(RenewalError);
    });

    it('throws RenewalError not_found when the process does not exist', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue(null);
        await expect(beginRenewal(5, 42)).rejects.toMatchObject({ code: 'not_found' });
    });

    describe('from PENDING_RENEWAL', () => {
        const pending = { id: 5, status: 'PENDING_RENEWAL', orgMembershipId: 9 };

        beforeEach(() => {
            prisma.orgMembershipProcess.findUnique.mockResolvedValue(pending);
            prisma.orgMembership.findUnique.mockResolvedValue({ householdId: 7 });
            prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: new Date(Date.UTC(2026, 8, 1)), bgRecheckMonths: 12 });
            prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });
            prisma.orgMembershipProcess.findUniqueOrThrow.mockResolvedValue({ ...pending, status: 'PENDING_PAYMENT' });
        });

        it('valid background check → PENDING_EXTERNAL_ACTION with bgClearedAt stamped: only the signature is left', async () => {
            prisma.person.findFirst.mockResolvedValue({ id: 1 }); // a lead with a valid background check

            await beginRenewal(5, 42);

            expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith({
                where: { id: 5, status: 'PENDING_RENEWAL' },
                data: expect.objectContaining({ status: 'PENDING_EXTERNAL_ACTION', bgClearedAt: expect.any(Date) }),
            });
            // The advance's PENDING_PAYMENT transition matches the volunteer
            // allowlist (#874) and pings reviewers — beginRenewal does neither.
            expect(applyVolunteerStatus).not.toHaveBeenCalled();
            expect(notifyReviewers).not.toHaveBeenCalled();
        });

        it('expired background check → PENDING_EXTERNAL_ACTION without bgClearedAt: sign + request a new background check', async () => {
            prisma.person.findFirst.mockResolvedValue(null); // no valid background check on file
            prisma.orgMembershipProcess.findUniqueOrThrow.mockResolvedValue({ ...pending, status: 'PENDING_EXTERNAL_ACTION' });

            await beginRenewal(5, 42);

            expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith({
                where: { id: 5, status: 'PENDING_RENEWAL' },
                data: expect.objectContaining({ status: 'PENDING_EXTERNAL_ACTION' }),
            });
            expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith({
                where: { id: 5, status: 'PENDING_RENEWAL' },
                data: expect.not.objectContaining({ bgClearedAt: expect.anything() }),
            });
            expect(applyVolunteerStatus).not.toHaveBeenCalled();
            // Nothing to review until the member consents on Averity — the
            // advance (advanceExternalIfComplete) pings, same as INITIAL.
            expect(notifyReviewers).not.toHaveBeenCalled();
        });

        it('double-submit loser (count 0) → no audit, no allowlist match, no ping', async () => {
            prisma.person.findFirst.mockResolvedValue({ id: 1 });
            prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 0 });

            await beginRenewal(5, 42);

            expect(prisma.auditLog.create).not.toHaveBeenCalled();
            expect(applyVolunteerStatus).not.toHaveBeenCalled();
            expect(notifyReviewers).not.toHaveBeenCalled();
        });
    });
});

describe('runRenewalSweep skip-probe shape', () => {
    it('in-flight arm stays kind=RENEWAL; the settled arm is the kind-agnostic handled fragment', async () => {
        // Pins the OR restructure: re-wrapping the whole probe in kind:"RENEWAL"
        // would restore double-billing of families that joined inside the window.
        const boundary = new Date(Date.UTC(2000, 7, 1)); // Aug 1
        prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: boundary });
        prisma.orgMembership.findMany.mockResolvedValue([]);

        const now = new Date(Date.UTC(2026, 6, 15)); // Jul 15 — inside the 2-month window
        await runRenewalSweep(now);

        const arg = prisma.orgMembership.findMany.mock.calls[0][0];
        const windowStart = monthsBefore(new Date(Date.UTC(2026, 7, 1)), 2);
        expect(arg.select.processes.where).toEqual({
            OR: [
                { kind: 'RENEWAL', status: { in: [...IN_FLIGHT_RENEWAL] } },
                handledThisCycleWhere(windowStart),
            ],
        });
    });
});
