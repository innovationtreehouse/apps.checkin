/**
 * @jest-environment node
 *
 * Verifies that POST /api/programs:
 * 1. Forwards `startAt` / `endAt` to prisma.program.create as Date objects
 *    (not null), and the response carries them back so the client can redirect.
 * 2. Stores those date-only strings at the calendar-date convention (UTC
 *    midnight), which formatDateOnly renders back as the picked date.
 */

import { POST } from '@/app/api/programs/route';
import { getServerSession } from 'next-auth/next';
import { formatDateOnly } from '@/lib/time';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

jest.mock('@/lib/notifications', () => ({
    sendNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/shopify', () => ({
}));

jest.mock('@/lib/logger', () => ({
    logBackendError: jest.fn().mockResolvedValue(undefined),
}));

const mockProgramCreate = jest.fn();
const mockAuditLogCreate = jest.fn().mockResolvedValue({});

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        person: {
            findUnique: jest.fn().mockResolvedValue({ dateOfBirth: null, isDeclaredAdult: true }),
        },
        program: {
            create: (...args: unknown[]) => mockProgramCreate(...args),
        },
        auditLog: {
            create: (...args: unknown[]) => mockAuditLogCreate(...args),
        },
    },
}));

describe('POST /api/programs — startAt/endAt date preservation', () => {
    const adminSession = {
        user: { id: 1, isSysadmin: true },
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
});
