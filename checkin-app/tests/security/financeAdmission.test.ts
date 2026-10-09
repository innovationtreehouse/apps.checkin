/**
 * Registry-wide admission invariants for the role-flag gates (catalog-viewer,
 * finance, finance-or-board, anyRole). Pure: no DB, no HTTP.
 *
 * 1. An id-less session — a JWT whose re-sync missed after a person merge or
 *    delete — is denied on every such route, even holding every flag. Prisma
 *    drops `where: { x: undefined }`, so admitting it would widen per-caller
 *    filters to every row (INVENTORY_PARALLEL_PORT_PLAN boundary rule 6).
 * 2. No finance route lists `isSysadmin` in its orderedView: Finance Ops
 *    excludes sysadmins (docs/rules/finance-payments.md).
 */
import { allRoutes, type Authorize, type RegisteredRoute } from '@/security/core';
import { resolveAccess, type ResolverContext } from '@/security/access-resolvers';
import type { AuthResult, AuthenticatedUser } from '@/types/auth';
import prisma from '@/lib/prisma';
import '@/security/registry';

const isRoleFlagGate = (a: Authorize) =>
    a === 'catalog-viewer' || a === 'finance' || a === 'finance-or-board' ||
    (typeof a === 'object' && 'anyRole' in a);

const isFinanceGate = (a: Authorize) =>
    a === 'finance' || a === 'finance-or-board' ||
    (typeof a === 'object' && 'anyRole' in a && a.anyRole.includes('isFinance'));

const everyFlagUser: AuthenticatedUser = {
    id: 1,
    email: 'idless@x.test',
    isSysadmin: true,
    isBoardMember: true,
    isKeyholder: true,
    isBackgroundCheckReviewer: true,
    isOperations: true,
    isInventoryManager: true,
    isFinance: true,
    programsLed: [1],
    householdId: 7,
};

const idless: AuthResult = { type: 'session', user: Object.assign({ ...everyFlagUser }, { id: undefined }) };

const ctx = (auth: AuthResult): ResolverContext => ({
    auth,
    params: { id: '1' },
    callerContext: {
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
    },
});

const gated = [...allRoutes()].filter(([, r]) => isRoleFlagGate(r.authorize));
const finance = [...allRoutes()].filter(([, r]) => isFinanceGate(r.authorize));

beforeEach(() => {
    // The designation leg would admit by email; make it match so only the id guard can deny.
    prisma.volunteerDesignation.findFirst = jest.fn().mockResolvedValue({ id: 1 });
});

describe('id-less session on role-flag gates', () => {
    test('the registry has role-flag-gated routes to check', () => {
        expect(gated.length).toBeGreaterThan(0);
    });

    test.each(gated)('%s denies an id-less session holding every flag', async (_endpoint, route) => {
        expect((await resolveAccess(route.authorize, ctx(idless))).allowed).toBe(false);
    });

    test.each<Authorize>([
        'catalog-viewer', 'finance', 'finance-or-board',
        { anyRole: ['isFinance'] }, { anyRole: ['isSysadmin', 'isBoardMember'] },
    ])('%j denies an id-less session holding every flag', async (authorize) => {
        expect((await resolveAccess(authorize, ctx(idless))).allowed).toBe(false);
    });

    test('catalog-viewer denies an id-less session on the designation leg alone', async () => {
        const designationOnly: AuthResult = {
            type: 'session',
            user: Object.assign({
                ...everyFlagUser,
                isSysadmin: false, isBoardMember: false, isKeyholder: false,
                isBackgroundCheckReviewer: false, isOperations: false,
                isInventoryManager: false, isFinance: false, programsLed: [],
            }, { id: undefined }),
        };
        expect((await resolveAccess('catalog-viewer', ctx(designationOnly))).allowed).toBe(false);
    });

    test.each<Authorize>([
        'catalog-viewer', 'finance', 'finance-or-board', { anyRole: ['isFinance'] },
    ])('%j still admits the same flags with an integer id', async (authorize) => {
        expect((await resolveAccess(authorize, ctx({ type: 'session', user: everyFlagUser }))).allowed).toBe(true);
    });
});

describe('finance routes never view-select isSysadmin', () => {
    const listsSysadmin = (r: Pick<RegisteredRoute, 'orderedView'>) =>
        r.orderedView.some(([role]) => role === 'isSysadmin');

    // Empty until the first finance route registers; the check below proves it bites.
    test('no finance-gated route lists isSysadmin in its orderedView', () => {
        expect(finance.filter(([, r]) => listsSysadmin(r)).map(([endpoint]) => endpoint)).toEqual([]);
    });

    test('the check catches a finance route that lists isSysadmin', () => {
        expect(isFinanceGate('finance') && listsSysadmin({ orderedView: [['isSysadmin', []]] })).toBe(true);
    });
});
