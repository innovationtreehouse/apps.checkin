/**
 * @jest-environment node
 */
import { PUT } from '../route';
import { getServerSession } from 'next-auth/next';
import prisma from '@/lib/prisma';
import { variantSlotYears } from '@/lib/programYear';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const tx = {
    boardSettings: { upsert: jest.fn(), findUniqueOrThrow: jest.fn() },
    membershipYearVariant: { upsert: jest.fn() },
    $executeRaw: jest.fn(),
    auditLog: { create: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
        boardSettings: { findUnique: jest.fn() },
    },
}));

function asUser(user: { isSysadmin: boolean; isBoardMember: boolean }) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 7, ...user } });
}
const send = (body: unknown) =>
    PUT(new Request('http://localhost:4000/api/settings/membership', { method: 'PUT', body: JSON.stringify(body) }));
const put = (body: object) => send({ ...body, perYearVariantClient: true });

describe('PUT /api/settings/membership releaseLibrary', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        tx.boardSettings.findUniqueOrThrow.mockResolvedValue({ id: 1, releasedLibraries: ['catalog', 'expense'] });
        asUser({ isSysadmin: false, isBoardMember: true });
    });

    it('merges the delta into the stored list in one statement and audits the delta', async () => {
        const res = await put({ releaseLibrary: { library: 'expense', released: true } });
        expect(res.status).toBe(200);
        expect((await res.json()).settings.releasedLibraries).toEqual(['catalog', 'expense']);

        expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
        const [sql, ...values] = tx.$executeRaw.mock.calls[0];
        expect(sql.join('?')).toMatch(/UPDATE "BoardSettings" SET "releasedLibraries"/);
        expect(values).toEqual(expect.arrayContaining(['expense', true]));
        expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ newData: { releaseLibrary: { library: 'expense', released: true } } }),
        }));
    });

    it('rejects a full-list write, bad keys, and non-board members', async () => {
        expect((await put({ releasedLibraries: ['catalog'] })).status).toBe(400);
        expect((await put({ releaseLibrary: { library: 'nope', released: true } })).status).toBe(400);
        expect((await put({ releaseLibrary: { library: 'catalog', released: 'yes' } })).status).toBe(400);
        asUser({ isSysadmin: true, isBoardMember: false });
        expect((await put({ releaseLibrary: { library: 'catalog', released: true } })).status).toBe(403);
        expect(tx.$executeRaw).not.toHaveBeenCalled();
    });
});

describe('PUT /api/settings/membership membershipYearVariants', () => {
    const boundary = new Date('2000-09-01T00:00:00.000Z');
    const [inProgress, coming] = variantSlotYears(boundary, new Date());
    const row = (over = {}) => ({ membershipYear: coming, shopifyVariantId: ' 222 ', productUrl: ' https://x/y ', ...over });

    beforeEach(() => {
        jest.clearAllMocks();
        tx.boardSettings.findUniqueOrThrow.mockResolvedValue({ id: 1 });
        tx.membershipYearVariant.upsert.mockReset();
        (prisma.boardSettings.findUnique as jest.Mock).mockResolvedValue({ orgMembershipYearBoundary: boundary });
        asUser({ isSysadmin: false, isBoardMember: true });
    });

    it('upserts by year, trimmed, and audits the write', async () => {
        expect((await put({ membershipYearVariants: [row()] })).status).toBe(200);
        const written = { membershipYear: coming, shopifyVariantId: '222', productUrl: 'https://x/y' };
        expect(tx.membershipYearVariant.upsert).toHaveBeenCalledWith({
            where: { membershipYear: coming },
            create: written,
            update: { shopifyVariantId: '222', productUrl: 'https://x/y' },
        });
        expect(tx.auditLog.create.mock.calls[0][0].data.newData).toEqual({ membershipYearVariants: [written] });
    });

    it.each([
        ['non-numeric variant', [row({ shopifyVariantId: 'abc' })]],
        ['empty variant', [row({ shopifyVariantId: ' ' })]],
        ['year before the two slots', [row({ membershipYear: inProgress - 1 })]],
        ['year past the coming year', [row({ membershipYear: coming + 1 })]],
        ['null entry', [null]],
        ['not a list', 'nope'],
    ])('refuses %s', async (_name, membershipYearVariants) => {
        expect((await put({ membershipYearVariants })).status).toBe(400);
        expect(tx.membershipYearVariant.upsert).not.toHaveBeenCalled();
    });

    it('refuses a row while no boundary is set', async () => {
        (prisma.boardSettings.findUnique as jest.Mock).mockResolvedValue({ orgMembershipYearBoundary: null });
        expect((await put({ membershipYearVariants: [row()] })).status).toBe(400);
    });

    it('answers 409 when another year holds the variant', async () => {
        tx.membershipYearVariant.upsert.mockRejectedValue({ code: 'P2002' });
        expect((await put({ membershipYearVariants: [row()] })).status).toBe(409);
    });
});

describe('PUT /api/settings/membership client marker', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        asUser({ isSysadmin: false, isBoardMember: true });
    });

    it.each([
        ['absent', { standardMembershipFeeCents: 0, orgMembershipYearBoundary: null }],
        ['not true', { perYearVariantClient: 'yes', standardMembershipFeeCents: 0 }],
    ])('refuses a body with the marker %s and changes nothing', async (_name, body) => {
        const res = await send(body);
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/reload/i);
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(tx.boardSettings.upsert).not.toHaveBeenCalled();
    });
});
