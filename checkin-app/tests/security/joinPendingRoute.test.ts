/**
 * A session with an open household question reaches only the routes that declare
 * `allowJoinPending`, and everywhere else it stays refused. Checked at both layers:
 * handler() behind a mocked next-auth session, and the resolvers directly, which
 * refuse it on their own without authenticateRequest. No DB, no HTTP.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { handler } from '@/security/handler';
import { allRoutes } from '@/security/core';
import { callerHoldsRole, resolveAccess, type CallerContext } from '@/security/access-resolvers';
import type { AuthResult, AuthenticatedUser } from '@/types/auth';
import '@/security/registry';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');

const FLAGGED = ['GET /api/profile/household-question', 'POST /api/profile/household-question'];
const UNFLAGGED = 'GET /api/profile/visits';

const accepted: AuthenticatedUser = {
    id: 1,
    email: 'pending@x.test',
    isSysadmin: false,
    isBoardMember: false,
    isKeyholder: false,
    isBackgroundCheckReviewer: false,
    isOperations: false,
    isInventoryManager: false,
    isFinance: false,
    householdLead: false,
    householdId: 7,
    programsLed: [],
    ageBand: 'adult',
    toolStatuses: [],
};
const pendingUser = { ...accepted, householdJoinPending: true };
const pending: AuthResult = { type: 'session', user: pendingUser };

const callerContext: CallerContext = {
    selfId: 1,
    householdId: 7,
    isKeyholder: false,
    isKiosk: false,
    programsLed: new Set<number>(),
    programsCoreVolIn: new Set<number>(),
    participantIdsInScopePrograms: new Set<number>(),
    householdIdsInScopePrograms: new Set<number>(),
    eventIdsInScopePrograms: new Set<number>(),
    activeVisitorIds: new Set<number>(),
    ledHouseholdMemberIds: new Set<number>(),
};

const req = () => new NextRequest('http://localhost/api/profile/household-question');
const signIn = (user: object) => jest.mocked(getServerSession).mockResolvedValue({ user, expires: '' });

describe('the registry', () => {
    test('flags only the household-question routes', () => {
        const flagged = [...allRoutes()].filter(([, r]) => r.allowJoinPending).map(([endpoint]) => endpoint);
        expect(flagged.sort()).toEqual([...FLAGGED].sort());
    });
});

describe('handler()', () => {
    test.each(FLAGGED)('%s admits a pending session and selects its view', async (endpoint) => {
        signIn(pendingUser);
        const fn = jest.fn().mockResolvedValue({ Household: { name: 'Rivera', line1: '1 Main St' } });

        const res = await handler(endpoint, fn)(req());

        expect(res.status).toBe(200);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(await res.json())).toContain('Rivera');
    });

    test.each(FLAGGED)('%s strips everything above the public tier', async (endpoint) => {
        signIn(pendingUser);
        const fn = jest.fn().mockResolvedValue({ Household: { name: 'Rivera', line1: '1 Main St' } });

        const res = await handler(endpoint, fn)(req());

        expect(JSON.stringify(await res.json())).not.toContain('1 Main St');
    });

    test('an unflagged route answers a pending session 401 without running', async () => {
        signIn(pendingUser);
        const fn = jest.fn();

        expect((await handler(UNFLAGGED, fn)(req())).status).toBe(401);
        expect(fn).not.toHaveBeenCalled();
    });

    test.each(FLAGGED)('%s still refuses a denied session with an open question', async (endpoint) => {
        signIn({ ...pendingUser, denied: true });
        const fn = jest.fn();

        expect((await handler(endpoint, fn)(req())).status).toBe(401);
        expect(fn).not.toHaveBeenCalled();
    });

    test.each(FLAGGED)('%s still refuses an id-less session with an open question', async (endpoint) => {
        signIn({ ...pendingUser, id: undefined });
        const fn = jest.fn();

        expect((await handler(endpoint, fn)(req())).status).toBe(401);
        expect(fn).not.toHaveBeenCalled();
    });
});

describe('the resolvers, on their own', () => {
    test('refuse a pending session by default', async () => {
        const { allowed } = await resolveAccess('authenticated', { auth: pending, params: {}, callerContext });

        expect(allowed).toBe(false);
        expect(callerHoldsRole('authenticated', pending, {}, callerContext)).toBe(false);
    });

    test('refuse a pending session when the option is false', async () => {
        const { allowed } = await resolveAccess('authenticated', { auth: pending, params: {}, callerContext, allowJoinPending: false });

        expect(allowed).toBe(false);
        expect(callerHoldsRole('authenticated', pending, {}, callerContext, { allowJoinPending: false })).toBe(false);
    });

    test('admit a pending session with the option', async () => {
        const { allowed } = await resolveAccess('authenticated', { auth: pending, params: {}, callerContext, allowJoinPending: true });

        expect(allowed).toBe(true);
        expect(callerHoldsRole('authenticated', pending, {}, callerContext, { allowJoinPending: true })).toBe(true);
    });
});
