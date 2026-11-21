import { checkValidFromForYear, positionCheckStanding } from '../positionHolders';

describe('position check standing', () => {
    const boundary = new Date('2000-09-01');
    const validFrom = checkValidFromForYear(boundary, 27, 2026);

    it('measures from the start of the year served', () => {
        expect(validFrom.toISOString().slice(0, 10)).toBe('2024-06-01');
    });

    it('is current on the edge, not current a day before, and no check without a date', () => {
        expect(positionCheckStanding(new Date('2024-06-01'), validFrom)).toBe('CURRENT');
        expect(positionCheckStanding(new Date('2024-05-31'), validFrom)).toBe('NOT_CURRENT');
        expect(positionCheckStanding(null, validFrom)).toBe('NO_CHECK');
    });
});
