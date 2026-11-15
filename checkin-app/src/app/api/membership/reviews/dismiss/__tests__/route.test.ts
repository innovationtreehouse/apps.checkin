/**
 * @jest-environment node
 */
/**
 * Route contract for POST /api/membership/reviews/dismiss: only a background-check
 * reviewer or a Board member is admitted — a family member, a household lead and a
 * sysadmin who is neither are refused — the reason is required, and ReviewError
 * codes map to HTTP.
 */
import { POST } from '../route';
import { getServerSession } from 'next-auth/next';
import { dismissCheckStarted, ReviewError } from '@/lib/membership/review';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/membership/review', () => ({ ...jest.requireActual('@/lib/membership/review'), dismissCheckStarted: jest.fn() }));

const post = (body: unknown) =>
    POST(new Request('http://localhost:4000/api/membership/reviews/dismiss', { method: 'POST', body: JSON.stringify(body) }) as unknown as Parameters<typeof POST>[0]);
const as = (roles: Record<string, boolean>) =>
    jest.mocked(getServerSession).mockResolvedValue({ user: { id: 7, householdId: 3, ...roles } });

beforeEach(() => jest.mocked(dismissCheckStarted).mockReset().mockResolvedValue(undefined));

describe('POST /api/membership/reviews/dismiss', () => {
    it.each([
        ['a reviewer', { isBackgroundCheckReviewer: true }],
        ['a Board member', { isBoardMember: true }],
    ])('admits %s and dismisses with the trimmed reason', async (_who, roles) => {
        as(roles);
        const res = await post({ processId: 5, reason: '  never took the check  ' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({});
        expect(dismissCheckStarted).toHaveBeenCalledWith(5, 7, 'never took the check');
    });

    it.each([
        ['a family member', {}],
        ['a household lead', { isHouseholdLead: true }],
        ['a sysadmin who is neither', { isSysadmin: true }],
    ])('refuses %s', async (_who, roles) => {
        as(roles);
        expect((await post({ processId: 5, reason: 'x' })).status).toBe(403);
        expect(dismissCheckStarted).not.toHaveBeenCalled();
    });

    it('400s without a reason or a processId', async () => {
        as({ isBoardMember: true });
        expect((await post({ processId: 5, reason: '  ' })).status).toBe(400);
        expect((await post({ reason: 'x' })).status).toBe(400);
        expect(dismissCheckStarted).not.toHaveBeenCalled();
    });

    it('maps a refused dismissal to its status', async () => {
        as({ isBoardMember: true });
        jest.mocked(dismissCheckStarted).mockRejectedValue(new ReviewError('wrong_phase', 'This check review has a decision on it, so it cannot be dismissed.'));
        const res = await post({ processId: 5, reason: 'x' });
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/cannot be dismissed/);
    });
});
