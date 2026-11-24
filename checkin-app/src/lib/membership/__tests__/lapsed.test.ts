import { isMembershipLapsed } from '@/lib/membership/lapsed';
import { calendarDayIn } from '@/lib/time';

describe('isMembershipLapsed', () => {
    const today = new Date('2026-10-12T00:00:00.000Z');
    const day = (offset: number) => new Date(today.getTime() + offset * 86_400_000).toISOString();

    it('a valid-through day behind today is lapsed', () => expect(isMembershipLapsed(day(-1), today)).toBe(true));
    it('valid through today is still covered', () => expect(isMembershipLapsed(day(0), today)).toBe(false));
    it('no valid-through date (none computable) is not lapsed', () => expect(isMembershipLapsed(null, today)).toBe(false));

    it("judges the lapse on the org zone's day", () => {
        // 12:30 AM on the 12th in New York, 11:30 PM on the 11th in Chicago.
        const instant = '2026-10-12T04:30:00Z';
        const validThrough = '2026-10-11T00:00:00.000Z';
        expect(isMembershipLapsed(validThrough, calendarDayIn(instant, 'America/New_York'))).toBe(true);
        expect(isMembershipLapsed(validThrough, calendarDayIn(instant, 'America/Chicago'))).toBe(false);
    });
});
