/**
 * authenticateRequest treats a session without a positive integer person id
 * as unauthenticated, so handler() answers 401 before admission or the route
 * body runs.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authenticateRequest } from '@/lib/auth';
import { handler } from '@/security/handler';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');

const user = (id: unknown) => ({
    id,
    email: 'p@x.test',
    isSysadmin: true,
    isBoardMember: true,
    isKeyholder: true,
    isBackgroundCheckReviewer: true,
    isOperations: true,
    isInventoryManager: true,
    isFinance: true,
});

const req = () => new NextRequest('http://localhost/api/profile');

describe.each([0, -1, 7.5, '7', undefined])('a session with id %p', (id) => {
    beforeEach(() => {
        jest.mocked(getServerSession).mockResolvedValue({ user: user(id), expires: '' });
    });

    test('authenticates as unauthenticated', async () => {
        expect(await authenticateRequest(req())).toEqual({ type: 'unauthenticated' });
    });

    test('gets 401 from handler() without running the route', async () => {
        const fn = jest.fn();
        expect((await handler('GET /api/profile', fn)(req())).status).toBe(401);
        expect(fn).not.toHaveBeenCalled();
    });
});

test('a session with a positive integer id authenticates as a session', async () => {
    jest.mocked(getServerSession).mockResolvedValue({ user: user(7), expires: '' });
    expect((await authenticateRequest(req())).type).toBe('session');
});
