import { nextBoundary, upcomingBoundary, renewalWindow, membershipYearCycle, liveMembershipYear, landsNextYear, memberYearStarts, birthCutoff, membershipYearOf, membershipYearLabel, programYearsTouched, variantSlotYears, applicationYear, reopenYearRefusal, membershipYearEnded } from '@/lib/programYear';
import { calculateAge, calendarDayIn } from '@/lib/time';

// Anchor "now" so the rollover branch is deterministic.
const NOW = new Date('2026-07-06T00:00:00Z');
const SEPT1 = '2000-09-01T00:00:00Z'; // stored boundary — only month/day matter

describe('nextBoundary', () => {
    it('picks this year when the boundary month/day is still ahead', () => {
        // Sept 1 2026 is after Jul 6 2026.
        expect(nextBoundary(new Date(SEPT1), NOW).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    });

    it('rolls to next year when the boundary month/day has already passed', () => {
        const now = new Date('2026-10-01T00:00:00Z'); // past Sept 1
        expect(nextBoundary(new Date(SEPT1), now).toISOString()).toBe('2027-09-01T00:00:00.000Z');
    });
});

describe('nextBoundary and upcomingBoundary on the boundary day', () => {
    const boundaryDay = new Date('2026-09-01T00:00:00Z');

    it('nextBoundary includes the boundary day itself', () => {
        expect(nextBoundary(new Date(SEPT1), boundaryDay).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    });

    it('upcomingBoundary skips it: the boundary day belongs to the year it opens', () => {
        expect(upcomingBoundary(new Date(SEPT1), boundaryDay).toISOString()).toBe('2027-09-01T00:00:00.000Z');
        expect(upcomingBoundary(new Date(SEPT1), new Date('2026-08-31T00:00:00Z')).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    });
});

// 01:00Z is 8 PM the evening before in Chicago: the year turns at the org's midnight, not UTC's.
describe('membership year on the org calendar day', () => {
    const boundary = new Date(SEPT1);
    const chicago = (iso: string) => calendarDayIn(new Date(iso), 'America/Chicago');
    const utc = (iso: string) => calendarDayIn(new Date(iso), 'UTC');

    it('the renewal window opens at the org\'s midnight', () => {
        const instant = '2026-07-01T01:00:00Z';
        expect(renewalWindow(boundary, chicago(instant)).inSeason).toBe(false);
        expect(renewalWindow(boundary, utc(instant)).inSeason).toBe(true);
        expect(membershipYearCycle(boundary, chicago(instant)).label).toBe('2025-2026');
        expect(liveMembershipYear(boundary, chicago(instant))).toBe(2025);
        expect(liveMembershipYear(boundary, utc(instant))).toBe(2026);
    });

    it('the boundary passes at the org\'s midnight', () => {
        const instant = '2026-09-01T01:00:00Z';
        expect(renewalWindow(boundary, chicago(instant))).toMatchObject({ boundary: new Date('2026-09-01T00:00:00Z'), inSeason: true });
        expect(renewalWindow(boundary, utc(instant))).toMatchObject({ boundary: new Date('2027-09-01T00:00:00Z'), inSeason: false });
        expect(membershipYearOf(boundary, chicago(instant))).toBe(2025);
    });

    it('on the boundary day itself the season is closed and the new year has begun', () => {
        const day = new Date('2026-09-01T00:00:00Z');
        expect(renewalWindow(boundary, day).inSeason).toBe(false);
        expect(membershipYearOf(boundary, day)).toBe(2026);
        expect(membershipYearCycle(boundary, day).label).toBe('2026-2027');
    });
});

describe('landsNextYear', () => {
    it('true when the program starts on/after the next cutoff', () => {
        expect(landsNextYear('2026-09-15T00:00:00Z', SEPT1, NOW)).toBe(true); // after Sept 1 2026
        expect(landsNextYear('2026-09-01T00:00:00Z', SEPT1, NOW)).toBe(true); // exactly the cutoff
    });

    it('false when the program starts before the next cutoff (current year)', () => {
        expect(landsNextYear('2026-08-01T00:00:00Z', SEPT1, NOW)).toBe(false);
    });

    it('false (unknown) when start date or cutoff is missing', () => {
        expect(landsNextYear(null, SEPT1, NOW)).toBe(false);
        expect(landsNextYear('2026-09-15T00:00:00Z', null, NOW)).toBe(false);
    });
});

describe('memberYearStarts', () => {
    it('brackets now with the year in progress and the upcoming one', () => {
        const { current, next } = memberYearStarts(new Date(SEPT1), NOW);
        expect(current.toISOString()).toBe('2025-09-01T00:00:00.000Z');
        expect(next.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    });

    it('rolls both forward once the boundary has passed', () => {
        const { current, next } = memberYearStarts(new Date(SEPT1), new Date('2026-10-01T00:00:00Z'));
        expect(current.toISOString()).toBe('2026-09-01T00:00:00.000Z');
        expect(next.toISOString()).toBe('2027-09-01T00:00:00.000Z');
    });
});

describe('birthCutoff', () => {
    const asOf = new Date('2026-09-01T00:00:00Z');

    it('is the DOB that turns exactly 18 on the boundary', () => {
        expect(birthCutoff(asOf).toISOString()).toBe('2008-09-01T00:00:00.000Z');
    });

    // The SQL-side `dateOfBirth <= birthCutoff(asOf)` filter must agree with the
    // JS age shown on the row, birthday-on-the-boundary included.
    it('agrees with calculateAge on both sides of the boundary', () => {
        const cutoff = birthCutoff(asOf);
        const dayLate = new Date('2008-09-02T00:00:00Z');
        expect(calculateAge(cutoff, asOf)).toBe(18);
        expect(calculateAge(dayLate, asOf)).toBe(17);
        expect(dayLate.getTime() <= cutoff.getTime()).toBe(false);
    });
});

describe('membership years', () => {
    const b = new Date(SEPT1);
    const d = (s: string) => new Date(`${s}T00:00:00Z`);

    it('a start on the boundary day is in the new year', () => {
        expect(membershipYearOf(b, d('2026-09-01'))).toBe(2026);
        expect(membershipYearOf(b, d('2026-08-31'))).toBe(2025);
    });

    it('labels a year in the spanning form', () => {
        expect(membershipYearLabel(2026)).toBe('2026-2027');
    });

    it('an end on the boundary day stays in the old year; one day later crosses', () => {
        expect(programYearsTouched(b, d('2026-06-01'), d('2026-09-01'))).toEqual([2025]);
        expect(programYearsTouched(b, d('2026-06-01'), d('2026-09-02'))).toEqual([2025, 2026]);
    });

    it('a one-day program on the boundary day is in the year it starts', () => {
        expect(programYearsTouched(b, d('2026-09-01'), d('2026-09-01'))).toEqual([2026]);
    });
});

describe('variantSlotYears', () => {
    const boundary = new Date('2000-09-01T00:00:00.000Z');

    it('turns over on the boundary day, not when the renewal window opens', () => {
        expect(variantSlotYears(boundary, new Date('2027-07-15T00:00:00.000Z'))).toEqual([2026, 2027]);
        expect(variantSlotYears(boundary, new Date('2027-08-31T23:59:59.000Z'))).toEqual([2026, 2027]);
        expect(variantSlotYears(boundary, new Date('2027-09-01T00:00:00.000Z'))).toEqual([2027, 2028]);
    });
});

describe("an application's stored year", () => {
    const b = new Date(Date.UTC(2000, 8, 1));
    const d = (s: string) => new Date(`${s}T00:00:00Z`);

    it('reads the stored year, whatever the creation date', () => {
        expect(applicationYear({ membershipYear: 2025, createdAt: d('2026-07-10') }, b)).toBe(2025);
    });

    it('falls back to the live year at creation for a row stored without one', () => {
        expect(applicationYear({ membershipYear: null, createdAt: d('2026-07-10') }, b)).toBe(2026);
        expect(applicationYear({ membershipYear: null, createdAt: '2026-06-20T00:00:00.000Z' }, b)).toBe(2025);
        expect(applicationYear({ membershipYear: null, createdAt: d('2026-07-10') }, null)).toBeNull();
    });

    it('refuses a reopen once the next renewal window opens, from the stored year', () => {
        expect(reopenYearRefusal('INITIAL', 2025, b, d('2026-06-30'))).toBeNull();
        expect(reopenYearRefusal('INITIAL', 2025, b, d('2026-07-01'))).toContain('This application is for 2025-2026.');
        expect(reopenYearRefusal('PERSON_BG', 2025, b, d('2027-07-01'))).toBeNull();
        expect(reopenYearRefusal('RENEWAL', null, b, d('2027-07-01'))).toBeNull();
    });

    it('a year ends at the boundary that closes it', () => {
        expect(membershipYearEnded(2025, b, d('2026-08-31'))).toBe(false);
        expect(membershipYearEnded(2025, b, d('2026-09-01'))).toBe(true);
    });
});
