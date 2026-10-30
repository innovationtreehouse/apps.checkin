/**
 * @jest-environment node
 */
/**
 * The Board's finance view log viewer (B11): the Board only is admitted, the
 * read itself is not audited, and the bag keeps the log row and the viewer's
 * name while dropping the viewer's contact details.
 */
import '@/security/registry';
import { getRoute } from '@/security/core';
import { stripValue } from '@/security/stripper';
import { resolveAccess, type CallerContext } from '@/security/access-resolvers';
import type { AuthenticatedUser } from '@/types/auth';

const ENDPOINT = 'GET /api/system-status/finance-views';

function ctx(): CallerContext {
    return {
        selfId: 1,
        householdId: undefined,
        isKeyholder: false,
        isKiosk: false,
        programsLed: new Set(),
        programsCoreVolIn: new Set(),
        participantIdsInScopePrograms: new Set(),
        householdIdsInScopePrograms: new Set(),
        eventIdsInScopePrograms: new Set(),
        activeVisitorIds: new Set(),
        ledHouseholdMemberIds: new Set(),
    };
}

const noFlags: AuthenticatedUser = {
    id: 5,
    email: 'caller@x.test',
    isSysadmin: false,
    isBoardMember: false,
    isKeyholder: false,
    isBackgroundCheckReviewer: false,
    isOperations: false,
    isInventoryManager: false,
    isFinance: false,
};

function spec() {
    const route = getRoute(ENDPOINT);
    if (!route) throw new Error(`no registry entry for ${ENDPOINT}`);
    return route;
}

async function admits(flags: Partial<AuthenticatedUser>): Promise<boolean> {
    const auth = { type: 'session' as const, user: { ...noFlags, ...flags } };
    return (await resolveAccess(spec().authorize, { auth, params: {}, callerContext: ctx() })).allowed;
}

function boardTokens() {
    const entry = spec().orderedView.find(([role]) => role === 'isBoardMember');
    if (!entry) throw new Error('no isBoardMember view');
    return entry[1];
}

describe('finance view log admission', () => {
    it('admits the Board', async () => {
        expect(await admits({ isBoardMember: true })).toBe(true);
    });

    it.each([
        ['finance', { isFinance: true }],
        ['a sysadmin', { isSysadmin: true }],
        ['operations', { isOperations: true }],
        ['a plain member', {}],
    ])('refuses %s', async (_label, flags) => {
        expect(await admits(flags)).toBe(false);
    });

    it('declares a view for the Board alone', () => {
        expect(spec().orderedView.map(([role]) => role)).toEqual(['isBoardMember']);
    });

    it('does not audit reading the log', () => {
        expect(spec().auditedRead).toBeUndefined();
    });
});

describe('finance view log strip', () => {
    const row = {
        id: 7,
        viewedAt: '2026-10-27T14:05:00.000Z',
        actorId: 12,
        role: 'isFinance',
        endpoint: 'GET /api/receipts/finance-queue',
        params: {},
        recordIds: ['r_1', 'r_2', 'r_3'],
        rowCount: 3,
        window: '2026-10-27T14:00:00.000Z',
        viewKey: 'ab12',
    };

    it('keeps every log field for the Board', () => {
        expect(stripValue('FinanceViewLog', row, boardTokens(), ctx())).toEqual(row);
    });

    it("keeps the viewer's name and drops their email", () => {
        const person = { id: 12, name: 'Pat Lee', email: 'pat@x.test' };
        expect(stripValue('Person', person, boardTokens(), ctx())).toEqual({ id: 12, name: 'Pat Lee' });
    });

    it('shows nothing of the log to a public-only view', () => {
        expect(stripValue('FinanceViewLog', row, ['public'], ctx())).toEqual({});
    });
});
