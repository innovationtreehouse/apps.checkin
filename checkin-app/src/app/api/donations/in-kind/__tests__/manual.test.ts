/**
 * @jest-environment node
 *
 * The no-receipt in-kind routes through the real handler, registry and library
 * route factories, with only the session, checkin's prisma and the library's
 * service calls doubled: admission, the ops donor strip, the required donor, and
 * the recorder's own-household refusal.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { configureBulkDonation, manualInKindService } from '@checkin/bulk-donation';
import { GET, POST } from '../manual/route';
import { POST as LOAD } from '../manual/[id]/load-inventory/route';
import { OWN_HOUSEHOLD_DONOR_MESSAGE } from '@/lib/bulkDonation/donorSelfGuard';
import { householdMembersOf, householdsSharingSurname, surname } from '@/lib/bulkDonation/donorSurname';
import prisma from '@/lib/prisma';

type PersonRow = { id: number; householdId: number; name: string; mergedIntoId?: number };
const people: PersonRow[] = [
    { id: 7, householdId: 70, name: 'Robin Okafor' },
    { id: 8, householdId: 70, name: 'Sam Okafor-Lee' },
    { id: 9, householdId: 90, name: 'Alex Brandt' },
    { id: 10, householdId: 90, name: 'Lee Varga', mergedIntoId: 3 },
];

const mockAuditCreate = jest.fn<Promise<object>, [unknown]>(async () => ({}));
jest.mock('@/lib/finance/financeViewLog', () => ({ recordFinanceView: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        person: {
            findUnique: jest.fn(async ({ where }: { where: { id: number } }) => people.find((p) => p.id === where.id) ?? null),
            findMany: jest.fn(async ({ where }: { where: { id?: number | { in: number[] }; householdId?: number | { in: number[] }; mergedIntoId?: null } }) => {
                const hit = (v: number, w: number | { in: number[] } | undefined) => w === undefined || (typeof w === 'number' ? v === w : w.in.includes(v));
                return people.filter(
                    (p) => hit(p.id, where.id) && hit(p.householdId, where.householdId) && (where.mergedIntoId !== null || p.mergedIntoId === undefined),
                );
            }),
        },
        // Deferred: jest.mock is hoisted above mockAuditCreate's initialisation.
        auditLog: { create: (arg: unknown) => mockAuditCreate(arg) },
    },
}));

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

type Flags = { isFinance?: boolean; isBoardMember?: boolean; isOperations?: boolean; isInventoryManager?: boolean };
function signIn(id: number, flags: Flags) {
    mockSession.mockResolvedValue({
        user: {
            id,
            isSysadmin: false,
            isBoardMember: false,
            isKeyholder: false,
            isBackgroundCheckReviewer: false,
            isOperations: false,
            isInventoryManager: false,
            isFinance: false,
            ...flags,
        },
    });
}

const URL_BASE = 'http://localhost/api/donations/in-kind/manual';
const noParams = { params: Promise.resolve({}) };
const post = (body: unknown) =>
    POST(new NextRequest(URL_BASE, { method: 'POST', body: JSON.stringify(body) }), noParams);
const valid = (lastName: string) => ({
    donor: { firstName: 'Pat', lastName, companyName: null },
    donationDate: '2026-10-01',
    lines: [{ gtin13: '0000000000017', quantity: 2, suggestedValueCents: 1500 }],
});

const donationRow = {
    id: 1,
    donationDate: '2026-10-01',
    recordedByUserId: 9,
    recordedByUsername: 'Alex',
    recordedAt: new Date('2026-10-02T00:00:00Z'),
    inventoryLoadedAt: null,
    donorFirstName: 'Pat',
    donorLastName: 'Rivera',
    donorCompanyName: 'Rivera Tools',
    lines: [{ id: 11, gtin13: '0000000000017', description: 'Drill', quantity: 2, valueCents: null, suggestedValueCents: 1500 }],
};

let list: jest.SpyInstance;
let record: jest.SpyInstance;
let load: jest.SpyInstance;

beforeAll(() => {
    configureBulkDonation({
        auth: { getPrincipal: async () => ({ id: 9, name: 'Alex' }) },
        org: async () => ({ id: 'treehouse', name: 'Treehouse' }),
    });
});

beforeEach(() => {
    mockSession.mockReset();
    mockAuditCreate.mockClear();
    list = jest.spyOn(manualInKindService, 'list').mockResolvedValue([donationRow]);
    record = jest.spyOn(manualInKindService, 'record').mockResolvedValue({ id: 1, inventoryLoaded: true });
    load = jest.spyOn(manualInKindService, 'loadInventory').mockResolvedValue();
});

afterEach(() => jest.restoreAllMocks());

describe('GET /api/donations/in-kind/manual', () => {
    it.each([{ isFinance: true }, { isBoardMember: true }])('%o reads donors, audited', async (flags) => {
        signIn(9, flags);
        const res = await GET(new NextRequest(URL_BASE), noParams);
        expect(res.status).toBe(200);
        const [row] = await res.json();
        expect(row).toMatchObject({ donorFirstName: 'Pat', donorLastName: 'Rivera', donorCompanyName: 'Rivera Tools' });
        expect(list.mock.calls[0][1]).toMatchObject({ actorUserId: 9, route: 'GET /api/donations/in-kind/manual' });
    });

    it.each([{ isOperations: true }, { isInventoryManager: true }])('%o gets no donor fields and no donor read', async (flags) => {
        signIn(9, flags);
        const res = await GET(new NextRequest(URL_BASE), noParams);
        expect(res.status).toBe(200);
        const [row] = await res.json();
        expect(row).not.toHaveProperty('donorFirstName');
        expect(row).not.toHaveProperty('donorLastName');
        expect(row).not.toHaveProperty('donorCompanyName');
        expect(row.lines).toEqual([{ id: 11, gtin13: '0000000000017', description: 'Drill', quantity: 2, valueCents: null, suggestedValueCents: 1500 }]);
        expect(list.mock.calls[0][1]).toBeNull();
    });

    it('refuses a plain session', async () => {
        signIn(9, {});
        expect((await GET(new NextRequest(URL_BASE), noParams)).status).toBe(403);
        expect(list).not.toHaveBeenCalled();
    });
});

describe('POST /api/donations/in-kind/manual', () => {
    it.each([{ isFinance: true }, { isOperations: true }, { isInventoryManager: true }])('%o records a gift from outside their household', async (flags) => {
        signIn(9, flags);
        const res = await post(valid('Okafor'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: 1, inventoryLoaded: true });
        expect(record).toHaveBeenCalledWith('treehouse', valid('Okafor'), expect.objectContaining({ actorUserId: 9 }));
    });

    it('ignores a merged person row in the household', async () => {
        signIn(9, { isOperations: true });
        expect((await post(valid('Varga'))).status).toBe(200);
        expect(record).toHaveBeenCalled();
    });

    it('refuses BOARD', async () => {
        signIn(9, { isBoardMember: true });
        expect((await post(valid('Okafor'))).status).toBe(403);
        expect(record).not.toHaveBeenCalled();
    });

    it.each([
        ['no donor', { donationDate: '2026-10-01', lines: valid('x').lines }],
        ['a blank last name', valid('')],
        ['a blank first name', { ...valid('Okafor'), donor: { firstName: '', lastName: 'Okafor', companyName: null } }],
    ])('requires a donor: %s is a 400', async (_label, body) => {
        signIn(9, { isOperations: true });
        expect((await post(body)).status).toBe(400);
        expect(record).not.toHaveBeenCalled();
    });

    it.each([
        ['the recorder', 'Brandt'],
        ['the recorder, differently cased and accented', 'BRÄNDT'],
    ])('refuses a gift from %s (403, audited without the donor)', async (_label, lastName) => {
        signIn(9, { isOperations: true });
        const res = await post(valid(lastName));
        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe(OWN_HOUSEHOLD_DONOR_MESSAGE);
        expect(record).not.toHaveBeenCalled();
        expect(mockAuditCreate).toHaveBeenCalledWith({
            data: {
                actorId: 9,
                affectedEntityId: 9,
                action: 'EDIT',
                tableName: 'SelfGrantRefusal',
                newData: { reason: 'own_household', table: 'ManualInKindDonation' },
            },
        });
    });

    it("refuses a gift from someone in the recorder's household", async () => {
        signIn(7, { isFinance: true });
        const res = await post(valid('Okafor-Lee'));
        expect(res.status).toBe(403);
        expect(record).not.toHaveBeenCalled();
        expect(mockAuditCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({ actorId: 7, affectedEntityId: 8 }),
        });
    });

    it('refuses when the recorder resolves to nobody (fail closed)', async () => {
        signIn(404, { isInventoryManager: true });
        expect((await post(valid('Okafor'))).status).toBe(403);
        expect(record).not.toHaveBeenCalled();
        expect(mockAuditCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({ newData: { reason: 'actor_household_unresolved', table: 'ManualInKindDonation' } }),
        });
    });

    it('refuses a donor last name with no letters or digits (fail closed)', async () => {
        signIn(9, { isOperations: true });
        expect((await post(valid('--'))).status).toBe(403);
        expect(record).not.toHaveBeenCalled();
    });
});

describe('POST /api/donations/in-kind/manual/[id]/load-inventory', () => {
    const call = () =>
        LOAD(new NextRequest(`${URL_BASE}/5/load-inventory`, { method: 'POST' }), { params: Promise.resolve({ id: '5' }) });

    it.each([{ isFinance: true }, { isOperations: true }, { isInventoryManager: true }])('%o retries the load', async (flags) => {
        signIn(9, flags);
        expect((await call()).status).toBe(200);
        expect(load).toHaveBeenCalledWith('treehouse', 5);
    });

    it('refuses BOARD', async () => {
        signIn(9, { isBoardMember: true });
        expect((await call()).status).toBe(403);
        expect(load).not.toHaveBeenCalled();
    });
});

describe('surname', () => {
    it.each([
        ['Robin Okafor', 'okafor'],
        ['  María  de la Peña ', 'pena'],
        ["O'Brien", "o'brien"],
        ['Robin Okafor Jr.', 'okafor'],
        ['Sam Okafor III', 'okafor'],
        ['Jr', ''],
        ['--', ''],
    ])('%s → %s', (name, expected) => {
        expect(surname(name)).toBe(expected);
    });
});

describe('in-kind household reads (the accept step\'s conflict rule and surname warning)', () => {
    it('matches a donor surname against anyone live in each person\'s household, in one batch', async () => {
        const checks = [
            { personId: 7, lastName: 'Okafor' },
            { personId: 7, lastName: 'Lee' },
            { personId: 9, lastName: 'Okafor' },
            { personId: 9, lastName: 'Varga' },
            { personId: 7, lastName: 'Jr' },
        ];
        await expect(householdsSharingSurname(prisma, checks)).resolves.toEqual([true, true, false, false, false]);
    });

    it('lists each person\'s live household, the person included', async () => {
        const households = await householdMembersOf(prisma, [7, 9]);
        expect(households.get(7)?.sort()).toEqual([7, 8]);
        expect(households.get(9)).toEqual([9]);
    });
});
