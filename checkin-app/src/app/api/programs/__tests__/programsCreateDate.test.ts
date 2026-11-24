/**
 * @jest-environment node
 *
 * Verifies that POST /api/programs:
 * 1. Forwards `startAt` / `endAt` to prisma.program.create as Date objects
 *    (not null), and the response carries them back so the client can redirect.
 * 2. Stores those date-only strings at the calendar-date convention (UTC
 *    midnight), which formatDateOnly renders back as the picked date.
 * 3. Refuses a name that is not a string, blank, or over 250 characters, and
 *    saves it trimmed.
 */

import { openPersonAgreementOnEngage } from '@/lib/membership/personAgreementTriggers';
import { POST } from '@/app/api/programs/route';
import { getServerSession } from 'next-auth/next';
import { formatDateOnly } from '@/lib/time';
import prisma from '@/lib/prisma';
import { LEADER_NEEDS_EMAIL } from '@/lib/programs/leaderEligibility';
import { ArchivedHouseholdError, lockLiveHouseholdsOf } from '@/lib/household/archiveGuard';

// The archived-household guard has its own tests; here every household is live.
// A new leader here meets the membership and clearance requirements; leaderEligibility has its own tests.
jest.mock('@/lib/orgMembership', () => ({ ...jest.requireActual('@/lib/orgMembership'), isActiveOrgMember: jest.fn().mockResolvedValue(true) }));
jest.mock('@/lib/membership/checkStanding', () => ({
    ...jest.requireActual('@/lib/membership/checkStanding'),
    checkStanding: jest.fn().mockReturnValue('CLEARED'),
    checkValidFor: jest.fn().mockResolvedValue(new Date('2000-01-01')),
    loadCheckReviews: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock("@/lib/household/archiveGuard", () => ({
    ...jest.requireActual("@/lib/household/archiveGuard"),
    lockLiveHouseholds: jest.fn(),
    lockLiveHouseholdsOf: jest.fn(),
}));

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

jest.mock('@/lib/notifications', () => ({
    sendNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/shopify/products', () => ({
    programProductHandle: jest.requireActual('@/lib/shopify/products').programProductHandle,
    createShopifySingleVariantProgram: jest.fn(),
    createClaimantProduct: jest.fn(),
}));
jest.mock('@/lib/shopify/stock', () => ({
    adjustProgramInventory: jest.fn().mockResolvedValue(true),
}));

jest.mock('@/lib/logger', () => ({
    logBackendError: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/membership/personAgreementTriggers', () => ({ openPersonAgreementOnEngage: jest.fn() }));

const mockProgramCreate = jest.fn();
const mockAuditLogCreate = jest.fn().mockResolvedValue({});

jest.mock('@/lib/prisma', () => {
    const db = {
        person: {
            findUnique: jest.fn().mockResolvedValue({ dateOfBirth: null, isDeclaredAdult: true, email: 'lead@example.com' }),
        },
        household: {
            count: jest.fn().mockResolvedValue(1),
        },
        program: {
            create: (...args: unknown[]) => mockProgramCreate(...args),
            update: jest.fn(({ data }: { data: object }) => Promise.resolve({ id: 45, name: 'x', ...data })),
        },
        auditLog: {
            create: (...args: unknown[]) => mockAuditLogCreate(...args),
        },
        boardSettings: {
            findUnique: jest.fn().mockResolvedValue({ orgMembershipYearBoundary: new Date('2000-09-01T00:00:00Z') }),
        },
        $transaction: (fn: (tx: unknown) => unknown) => fn(db),
    };
    return { __esModule: true, default: db };
});

describe('POST /api/programs — name', () => {
    const post = (name: unknown) => POST(new Request('http://localhost/api/programs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, leadMentorId: 7, startAt: '2024-09-01', endAt: '2024-12-15', maxParticipants: 5 }),
    }) as unknown as import('next/server').NextRequest);

    beforeEach(() => {
        jest.clearAllMocks();
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 1, isBoardMember: true } });
        mockProgramCreate.mockResolvedValue({ id: 45, name: 'x' });
    });

    it.each([
        ['a number', 123],
        ['an object', { first: 'x' }],
        ['whitespace only', '   '],
        ['251 characters', 'a'.repeat(251)],
    ])('refuses %s', async (_label, name) => {
        const res = await post(name);
        expect(res.status).toBe(400);
        expect(mockProgramCreate).not.toHaveBeenCalled();
    });

    it('refuses a leader with no email on file, creating nothing', async () => {
        (prisma.person.findUnique as jest.Mock).mockResolvedValueOnce({ dateOfBirth: null, isDeclaredAdult: true, email: null });
        const res = await post('Woodshop');
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe(LEADER_NEEDS_EMAIL);
        expect(mockProgramCreate).not.toHaveBeenCalled();
    });

    it('accepts 250 characters', async () => {
        const name = 'a'.repeat(250);
        expect((await post(name)).status).toBe(200);
        expect(mockProgramCreate.mock.calls[0][0].data.name).toBe(name);
    });

    it('saves the trimmed name', async () => {
        expect((await post('  Woodshop  ')).status).toBe(200);
        expect(mockProgramCreate.mock.calls[0][0].data.name).toBe('Woodshop');
    });

    it('opens the named leader\'s individual agreement if they owe one: leading a program is taking part', async () => {
        expect((await post('Woodshop')).status).toBe(200);
        expect(openPersonAgreementOnEngage).toHaveBeenCalledWith(7);
    });

    it('writes the name key with the name', async () => {
        await post('  WoodShop  ');
        expect(mockProgramCreate.mock.calls[0][0].data).toMatchObject({ name: 'WoodShop', nameKey: 'woodshop' });
    });

    it('refuses a name its membership year already has with 409, before any store product', async () => {
        mockProgramCreate.mockRejectedValueOnce({ code: 'P2002', meta: { driverAdapterError: { cause: { constraint: { fields: ['"nameKey"', '"appliesToYear"'] } } } } });
        const res = await POST(new Request('http://localhost/api/programs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Woodshop', leadMentorId: 7, startAt: '2024-09-01', endAt: '2024-12-15', maxParticipants: 5, nonMemberPrice: '50' }),
        }) as unknown as import('next/server').NextRequest);
        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe('A program with this name already exists for that membership year.');
        const { createShopifySingleVariantProgram, createClaimantProduct } = jest.requireMock('@/lib/shopify/products');
        expect(createShopifySingleVariantProgram).not.toHaveBeenCalled();
        expect(createClaimantProduct).not.toHaveBeenCalled();
    });

    it('warns, naming the reserved-seat product, when only that product fails', async () => {
        const { createShopifySingleVariantProgram, createClaimantProduct } = jest.requireMock('@/lib/shopify/products');
        createShopifySingleVariantProgram.mockResolvedValueOnce({ shopifyProductId: 'p1', shopifyVariantId: 'v1' });
        createClaimantProduct.mockResolvedValueOnce(null);
        const res = await POST(new Request('http://localhost/api/programs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Woodshop', leadMentorId: 7, startAt: '2024-09-01', endAt: '2024-12-15', maxParticipants: 5, nonMemberPrice: '50' }),
        }) as unknown as import('next/server').NextRequest);
        expect(res.status).toBe(200);
        expect((await res.json()).warning).toMatch(/reserved-seat product failed/);
    });
});

describe('POST /api/programs — startAt/endAt date preservation', () => {
    const adminSession = {
        user: { id: 1, isBoardMember: true },
    };

    beforeEach(() => {
        jest.clearAllMocks();
        (getServerSession as jest.Mock).mockResolvedValue(adminSession);
    });

    it('passes startAt and endAt as Date objects when both are supplied', async () => {
        const beginStr = '2024-09-01';
        const endStr = '2024-12-15';

        const createdProgram = {
            id: 42,
            name: 'Test Program',
            leadMentorId: 7,
            startAt: new Date(beginStr),
            endAt: new Date(endStr),
            orgMemberOnly: false,
            minAge: null,
            maxAge: null,
            orgMemberPriceCents: null,
            nonOrgMemberPriceCents: null,
            maxParticipants: null,
            phase: 'PLANNING',
            enrollmentStatus: 'CLOSED',
            shopifyProductId: null,
        };
        mockProgramCreate.mockResolvedValue(createdProgram);

        const req = new Request('http://localhost/api/programs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Test Program',
                leadMentorId: 7,
                startAt: beginStr,
                endAt: endStr,
                maxParticipants: 50,
            }),
        }) as unknown as import('next/server').NextRequest;

        const res = await POST(req);
        expect(res.status).toBe(200);

        // Verify prisma.program.create received Date objects, not strings or null
        expect(mockProgramCreate).toHaveBeenCalledTimes(1);
        const createArgs = mockProgramCreate.mock.calls[0][0] as { data: Record<string, unknown> };
        expect(createArgs.data.startAt).toBeInstanceOf(Date);
        expect(createArgs.data.endAt).toBeInstanceOf(Date);
        // Calendar-date convention: UTC midnight (design doc Axis 1)
        expect((createArgs.data.startAt as Date).toISOString()).toBe('2024-09-01T00:00:00.000Z');
        expect((createArgs.data.endAt as Date).toISOString()).toBe('2024-12-15T00:00:00.000Z');

        // Verify the response body includes program.startAt so the client can
        // read data.program.id and redirect to the detail page
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.program).toBeDefined();
        expect(body.program.id).toBe(42);
        // startAt in the response is serialised as an ISO string by JSON.stringify
        expect(body.program.startAt).toBeTruthy();
    });

    // Invariant: the stored instant renders as the picked calendar date on the
    // Programs list and repopulates the edit form unchanged.
    it.each(['2026-01-15', '2026-03-08', '2026-09-01', '2026-11-01'])(
        'renders %s back as the same calendar date after a create round-trip',
        async (picked) => {
            mockProgramCreate.mockResolvedValue({ id: 44, name: 'Round Trip' });

            const req = new Request('http://localhost/api/programs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: 'Round Trip',
                    leadMentorId: 7,
                    startAt: picked,
                    endAt: picked,
                    maxParticipants: 50,
                }),
            }) as unknown as import('next/server').NextRequest;

            expect((await POST(req)).status).toBe(200);

            const { data } = mockProgramCreate.mock.calls[0][0] as { data: Record<string, unknown> };
            const [y, m, d] = picked.split('-').map(Number);
            expect(formatDateOnly(data.startAt as Date)).toBe(`${m}/${d}/${y}`);
            expect((data.startAt as Date).toISOString().split('T')[0]).toBe(picked);
            expect((data.endAt as Date).toISOString().split('T')[0]).toBe(picked);
        },
    );

    it('rejects when startAt is omitted', async () => {
        const req = new Request('http://localhost/api/programs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'No-Date Program',
                leadMentorId: 7,
                maxParticipants: 50,
                endAt: '2026-12-31',
            }),
        }) as unknown as import('next/server').NextRequest;

        const res = await POST(req);
        expect(res.status).toBe(400);
        expect(mockProgramCreate).not.toHaveBeenCalled();
    });

    it('rejects when endAt is omitted', async () => {
        const req = new Request('http://localhost/api/programs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'No-Date Program',
                leadMentorId: 7,
                maxParticipants: 50,
                startAt: '2026-01-01',
            }),
        }) as unknown as import('next/server').NextRequest;

        const res = await POST(req);
        expect(res.status).toBe(400);
        expect(mockProgramCreate).not.toHaveBeenCalled();
    });

    describe('age bounds', () => {
        const createdData = () => (mockProgramCreate.mock.calls[0][0] as { data: { minAge: number | null; maxAge: number | null } }).data;
        const create = (body: Record<string, unknown>) => POST(new Request('http://localhost/api/programs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Age Program', leadMentorId: 7, maxParticipants: 50, startAt: '2026-09-01', endAt: '2026-09-02', ...body }),
        }) as unknown as import('next/server').NextRequest);

        beforeEach(() => mockProgramCreate.mockResolvedValue({ id: 46, name: 'Age Program' }));

        it('stores a typed maxAge of 0 as 0', async () => {
            expect((await create({ maxAge: 0 })).status).toBe(200);
            expect(createdData().maxAge).toBe(0);
        });

        it('stores a typed minAge of 0 as 0', async () => {
            expect((await create({ minAge: 0 })).status).toBe(200);
            expect(createdData().minAge).toBe(0);
        });

        it('stores an omitted bound as null', async () => {
            expect((await create({})).status).toBe(200);
            expect(createdData()).toMatchObject({ minAge: null, maxAge: null });
        });
    });

    describe('membership year', () => {
        const create = (body: Record<string, unknown>) => POST(new Request('http://localhost/api/programs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Year Program', leadMentorId: 7, maxParticipants: 50, ...body }),
        }) as unknown as import('next/server').NextRequest);
        const createdYear = () => (mockProgramCreate.mock.calls[0][0] as { data: { appliesToYear: number } }).data.appliesToYear;

        beforeEach(() => mockProgramCreate.mockResolvedValue({ id: 45, name: 'Year Program' }));

        it('derives the year when the dates fall inside one', async () => {
            expect((await create({ startAt: '2026-09-01', endAt: '2027-08-31' })).status).toBe(200);
            expect(createdYear()).toBe(2026);
        });

        it('stores the year a Board member states for a crossing program', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 1, isBoardMember: true } });
            expect((await create({ startAt: '2026-01-01', endAt: '2026-12-31', appliesToYear: 2025 })).status).toBe(200);
            expect(createdYear()).toBe(2025);
        });

        it('rejects an inverted range before judging its year', async () => {
            expect((await create({ startAt: '2026-10-01', endAt: '2026-06-01' })).status).toBe(400);
            expect(mockProgramCreate).not.toHaveBeenCalled();
        });

    });
});

describe('POST /api/programs — a leader in an archived household', () => {
    const create = () => POST(new Request('http://localhost/api/programs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Program', leadMentorId: 7, startAt: '2024-09-01', endAt: '2024-12-15', maxParticipants: 50 }),
    }) as unknown as import('next/server').NextRequest);

    beforeEach(() => {
        jest.clearAllMocks();
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 1, isBoardMember: true } });
    });

    it('is refused before anything is created', async () => {
        (prisma.household.count as jest.Mock).mockResolvedValueOnce(0);
        const res = await create();
        expect(res.status).toBe(409);
        expect((await res.json()).error).toContain('archived');
        expect(mockProgramCreate).not.toHaveBeenCalled();
    });

    it('is refused when the household is archived while the program is being created', async () => {
        (lockLiveHouseholdsOf as jest.Mock).mockRejectedValueOnce(new ArchivedHouseholdError());
        const res = await create();
        expect(res.status).toBe(409);
        expect(mockProgramCreate).not.toHaveBeenCalled();
    });
});

describe('POST /api/programs — a leader who does not meet the policy', () => {
    const create = () => POST(new Request('http://localhost/api/programs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Program', leadMentorId: 7, startAt: '2024-09-01', endAt: '2024-12-15', maxParticipants: 50 }),
    }) as unknown as import('next/server').NextRequest);

    beforeEach(() => {
        jest.clearAllMocks();
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 1, isBoardMember: true } });
    });

    it('is refused when not in an ACTIVE household membership, before anything is created', async () => {
        (jest.requireMock('@/lib/orgMembership').isActiveOrgMember as jest.Mock).mockResolvedValueOnce(false);
        const res = await create();
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/active Treehouse Membership/);
        expect(mockProgramCreate).not.toHaveBeenCalled();
    });

    it('is refused without a current background-check clearance', async () => {
        (jest.requireMock('@/lib/membership/checkStanding').checkStanding as jest.Mock).mockReturnValueOnce('NONE');
        const res = await create();
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/background-check clearance/);
        expect(mockProgramCreate).not.toHaveBeenCalled();
    });
});

describe('POST /api/programs — naming oneself the leader', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 7, isBoardMember: true } });
    });

    it('is refused, and the refused attempt is audited', async () => {
        const res = await POST(new Request('http://localhost/api/programs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Robotics', leadMentorId: 7, startAt: '2024-09-01', endAt: '2024-12-15', maxParticipants: 5 }),
        }) as unknown as import('next/server').NextRequest);

        expect(res.status).toBe(403);
        expect(mockProgramCreate).not.toHaveBeenCalled();
        expect(mockAuditLogCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({
                actorId: 7, affectedEntityId: 7, tableName: 'SelfGrantRefusal',
                newData: expect.objectContaining({ table: 'Program', attempted: { name: 'Robotics', leadMentorId: 7 } }),
            }),
        });
    });
});
