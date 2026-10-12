import { isMembershipLapsed } from '@/lib/membership/lapsed';
import { orgCalendarDay } from '@/lib/time';

describe('isMembershipLapsed', () => {
    const today = orgCalendarDay();
    const day = (offset: number) => new Date(today.getTime() + offset * 86_400_000).toISOString();

    it('a valid-through day behind today is lapsed', () => expect(isMembershipLapsed(day(-1))).toBe(true));
    it('valid through today is still covered', () => expect(isMembershipLapsed(day(0))).toBe(false));
    it('no valid-through date (none computable) is not lapsed', () => expect(isMembershipLapsed(null)).toBe(false));
});
