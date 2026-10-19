import { nextBoundary, landsNextYear, memberYearStarts, birthCutoff, membershipYearOf, membershipYearLabel, programYearsTouched } from '@/lib/programYear';
import { calculateAge } from '@/lib/time';

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
