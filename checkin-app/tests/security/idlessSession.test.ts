/**
 * Registry-wide invariant: a session with no integer person id is
 * unauthenticated (INVENTORY_PARALLEL_PORT_PLAN boundary rule 6). Every
 * registered route that is not `public` or `kiosk` denies it, and no view role
 * other than `anyone`/`unauthenticated` selects for it — even when the token
 * carries every role flag, a certifier toolStatus, household leadership and a
 * led program. Prisma drops `where: { x: undefined }`, so admitting it would
 * widen per-caller filters to every row. Checked at both layers: the resolvers
 * directly, and handler() behind a mocked next-auth session,
 * where authenticateRequest turns it into a 401. No DB, no HTTP.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { handler } from '@/security/handler';
import { allFileRoutes, allRoutes, CRON_SECRET_ENV, ROLES, type Authorize, type CronSecretName, type Role } from '@/security/core';
import { callerHoldsRole, resolveAccess, type CallerContext } from '@/security/access-resolvers';
import type { AuthResult, AuthenticatedUser } from '@/types/auth';
import '@/security/registry';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');

const everything: AuthenticatedUser = {
    id: 1,
    email: 'idless@x.test',
    isSysadmin: true,
    isBoardMember: true,
    isKeyholder: true,
    isBackgroundCheckReviewer: true,
    isOperations: true,
    isInventoryManager: true,
    isFinance: true,
    householdLead: true,
    householdId: 7,
    programsLed: [1],
    ageBand: 'adult',
    toolStatuses: [{ toolId: 1, level: 'MAY_CERTIFY_OTHERS' }],
};

const identified: AuthResult = { type: 'session', user: everything };
const idless: AuthResult = { type: 'session', user: Object.assign({ ...everything }, { id: undefined }) };

// A context as if the caller leads and core-vols program 1, so only the id guard can deny.
const callerContext: CallerContext = {
    selfId: undefined,
    householdId: 7,
    isKeyholder: true,
    isKiosk: false,
    programsLed: new Set([1]),
    programsCoreVolIn: new Set([1]),
    participantIdsInScopePrograms: new Set<number>(),
    householdIdsInScopePrograms: new Set<number>(),
    eventIdsInScopePrograms: new Set<number>(),
    activeVisitorIds: new Set<number>(),
    ledHouseholdMemberIds: new Set<number>(),
};

// With and without an id param: 'self' admits on a matching id, or on none.
const PARAMS: Record<string, string>[] = [{ id: '1' }, {}];

const OPEN: Authorize[] = ['public', 'kiosk'];
const gated = [...allRoutes(), ...allFileRoutes()].filter(([, r]) => !OPEN.includes(r.authorize));

describe('id-less session', () => {
    test('the registry has gated routes to check', () => {
        expect(gated.length).toBeGreaterThan(0);
    });

    test.each(gated)('%s denies it', async (_endpoint, route) => {
        for (const params of PARAMS) {
            expect((await resolveAccess(route.authorize, { auth: idless, params, callerContext })).allowed).toBe(false);
        }
    });

    test.each<Authorize>([
        'authenticated', 'self', 'catalog-viewer', 'receipt-submitter', 'inventory-manager', 'finance', 'finance-or-board', 'expense-approver', 'expense-signer',
        'certifier', 'program-lead-mentor', 'program-core-volunteer', 'household-lead', 'household-member',
        { anyRole: ['isSysadmin', 'isBoardMember', 'isInventoryManager', 'isFinance'] },
    ])('%j denies it, and admits the same caller with an id', async (authorize) => {
        for (const params of PARAMS) {
            expect((await resolveAccess(authorize, { auth: idless, params, callerContext })).allowed).toBe(false);
        }
        expect((await resolveAccess(authorize, { auth: identified, params: { id: '1' }, callerContext })).allowed).toBe(true);
    });

    const OPEN_ROLES: Role[] = ['anyone', 'unauthenticated'];
    test.each(ROLES.filter(r => !OPEN_ROLES.includes(r)))('view role %s does not select it', (role) => {
        expect(callerHoldsRole(role, idless, { id: '1' }, callerContext)).toBe(false);
    });

    test.each([0, -1, 7.5, NaN, '7'])('a session with id %p is denied like an id-less one', async (id) => {
        const auth: AuthResult = { type: 'session', user: Object.assign({ ...everything }, { id }) };
        expect((await resolveAccess('inventory-manager', { auth, params: {}, callerContext })).allowed).toBe(false);
        expect(callerHoldsRole('isInventoryManager', auth, {}, callerContext)).toBe(false);
    });

    test('it selects the unauthenticated view', () => {
        expect(callerHoldsRole('unauthenticated', idless, {}, callerContext)).toBe(true);
    });
});

describe('denied session reaching the resolvers directly', () => {
    const denied: AuthResult = { type: 'session', user: { ...everything, denied: true } };

    test.each(gated)('%s denies it', async (_endpoint, route) => {
        for (const params of PARAMS) {
            expect((await resolveAccess(route.authorize, { auth: denied, params, callerContext })).allowed).toBe(false);
        }
    });

    test('public still admits it, and a not-denied caller keeps its gates', async () => {
        expect((await resolveAccess('public', { auth: denied, params: {}, callerContext })).allowed).toBe(true);
        const notDenied: AuthResult = { type: 'session', user: { ...everything, denied: false } };
        expect((await resolveAccess('finance', { auth: notDenied, params: {}, callerContext })).allowed).toBe(true);
        expect(callerHoldsRole('isFinance', notDenied, {}, callerContext)).toBe(true);
    });

    const OPEN_ROLES: Role[] = ['anyone', 'unauthenticated'];
    test.each(ROLES.filter(r => !OPEN_ROLES.includes(r)))('view role %s does not select it', (role) => {
        expect(callerHoldsRole(role, denied, { id: '1' }, callerContext)).toBe(false);
    });

    test.each(OPEN_ROLES)('view role %s selects it', (role) => {
        expect(callerHoldsRole(role, denied, {}, callerContext)).toBe(true);
    });

    test('a cron route answers on the secret alone', async () => {
        const name = 'CRON_SECRET_FOR_TEST';
        const entry = Object.entries(CRON_SECRET_ENV)[0] as [CronSecretName, string];
        const original = process.env[entry[1]];
        process.env[entry[1]] = name;
        try {
            const { allowed } = await resolveAccess({ cronSecret: entry[0] }, {
                auth: denied, params: {}, callerContext, authorization: `Bearer ${name}`,
            });
            expect(allowed).toBe(true);
        } finally {
            if (original === undefined) delete process.env[entry[1]];
            else process.env[entry[1]] = original;
        }
    });
});

describe('id-less session through handler()', () => {
    beforeEach(() => {
        jest.mocked(getServerSession).mockResolvedValue({ user: { ...everything, id: undefined }, expires: '' });
    });

    const req = () => new NextRequest('http://localhost/api/x');
    const params = { params: Promise.resolve({ id: '1' }) };

    test.each([...allRoutes()].filter(([, r]) => !OPEN.includes(r.authorize)))('%s answers 401 without running', async (endpoint) => {
        const fn = jest.fn();
        expect((await handler(endpoint, fn)(req(), params)).status).toBe(401);
        expect(fn).not.toHaveBeenCalled();
    });
});
