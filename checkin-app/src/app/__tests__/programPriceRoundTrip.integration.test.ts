/**
 * @jest-environment node
 */
/**
 * Integration Tests for Program price persistence (dollars -> cents).
 *
 * Unlike price-cents.test.ts (which tests dollarsToCentsOrNull in isolation),
 * these push a decimal dollar string through the REAL create/update routes and
 * read back the persisted Program, guarding the $25.99 -> $25 truncation
 * regression at the DB boundary.
 *   CREATE conversion: src/app/api/programs/route.ts:109-110
 *   PATCH  conversion: src/app/api/programs/[id]/route.ts:108-109
 */

import { POST } from '@/app/api/programs/route';
import { PATCH } from '@/app/api/programs/[id]/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { setMembershipYearBoundary } from '@/test-helpers/boardSettings';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));
jest.mock('@/lib/notifications', () => ({
    sendNotification: jest.fn(),
}));
// Avoid hitting the real Shopify API; the route tolerates a null result.
jest.mock('@/lib/shopify/products', () => ({
    createShopifySingleVariantProgram: jest.fn().mockResolvedValue(null),
}));
jest.mock('@/lib/shopify/stock', () => ({
    syncProgramPrice: jest.fn().mockResolvedValue(true),
}));

const PROGRAM_NAME_TAG = 'Price RoundTrip Test Program';

describe('Program price round-trip (dollars -> cents) Integration Tests', () => {
    // Program writes need the membership-year boundary.
    let restoreBoundary: () => Promise<void>;
    beforeAll(async () => { restoreBoundary = await setMembershipYearBoundary(); });
    afterAll(async () => { await restoreBoundary(); });

    let adminId: number;
    let leadId: number;

    beforeAll(async () => {
        const existingUsers = await prisma.person.findMany({
            where: { email: { contains: 'price-roundtrip-test' } },
            select: { id: true },
        });
        const existingUserIds = existingUsers.map(u => u.id);

        await prisma.program.deleteMany({ where: { name: { contains: PROGRAM_NAME_TAG } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: existingUserIds } } });
        await prisma.person.deleteMany({ where: { id: { in: existingUserIds } } });

        const admin = await prisma.person.create({
            data: { email: 'admin-price-roundtrip-test@example.com', name: 'Admin', isSysadmin: true, household: { create: { name: "Test HH" } } },
        });
        adminId = admin.id;

        const lead = await prisma.person.create({
            data: { email: 'lead-price-roundtrip-test@example.com', name: 'Lead', isDeclaredAdult: true, household: { create: { name: "Test HH" } } },
        });
        leadId = lead.id;
    });

    afterAll(async () => {
        const ids = [adminId, leadId];
        await prisma.program.deleteMany({ where: { name: { contains: PROGRAM_NAME_TAG } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
    });

    describe('CREATE: POST /api/programs', () => {
        it('persists a decimal price as exact cents (no $25.99 -> $25 truncation)', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

            const name = `${PROGRAM_NAME_TAG} decimal`;
            const req = new Request('http://localhost:4000/api/programs', {
                method: 'POST',
                body: JSON.stringify({ name, leadMentorId: leadId, startAt: '2026-01-01', endAt: '2026-06-30', memberPrice: '25.99', nonMemberPrice: '100', maxParticipants: 50 }),
            });
            const res = await POST(req as unknown as import('next/server').NextRequest);
            expect(res.status).toBe(200);

            const persisted = await prisma.program.findFirstOrThrow({ where: { name } });
            expect(persisted.orgMemberPriceCents).toBe(2599);
            expect(persisted.nonOrgMemberPriceCents).toBe(10000);
        });

        it('persists a whole-dollar price as cents and keeps an empty price null', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

            const name = `${PROGRAM_NAME_TAG} wholedollar`;
            const req = new Request('http://localhost:4000/api/programs', {
                method: 'POST',
                body: JSON.stringify({ name, leadMentorId: leadId, startAt: '2026-01-01', endAt: '2026-06-30', memberPrice: '30', nonMemberPrice: '', maxParticipants: 50 }),
            });
            const res = await POST(req as unknown as import('next/server').NextRequest);
            expect(res.status).toBe(200);

            const persisted = await prisma.program.findFirstOrThrow({ where: { name } });
            expect(persisted.orgMemberPriceCents).toBe(3000);
            expect(persisted.nonOrgMemberPriceCents).toBeNull();
        });

        it('keeps both prices null when omitted', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

            const name = `${PROGRAM_NAME_TAG} null`;
            const req = new Request('http://localhost:4000/api/programs', {
                method: 'POST',
                body: JSON.stringify({ name, leadMentorId: leadId, startAt: '2026-01-01', endAt: '2026-06-30', maxParticipants: 50 }),
            });
            const res = await POST(req as unknown as import('next/server').NextRequest);
            expect(res.status).toBe(200);

            const persisted = await prisma.program.findFirstOrThrow({ where: { name } });
            expect(persisted.orgMemberPriceCents).toBeNull();
            expect(persisted.nonOrgMemberPriceCents).toBeNull();
        });
    });

    describe('PATCH: PATCH /api/programs/[id]', () => {
        it('persists decimal prices as exact cents on update', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

            const name = `${PROGRAM_NAME_TAG} patch`;
            const program = await prisma.program.create({
                data: { appliesToYear: 2026, name, leadMentorId: leadId, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), orgMemberPriceCents: 100, nonOrgMemberPriceCents: 200 },
            });

            const req = new Request(`http://localhost:4000/api/programs/${program.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ memberPrice: '12.50', nonMemberPrice: '99.99' }),
            });
            const res = await PATCH(req as unknown as Request, { params: Promise.resolve({ id: String(program.id) }) });
            expect(res.status).toBe(200);

            const persisted = await prisma.program.findUniqueOrThrow({ where: { id: program.id } });
            expect(persisted.orgMemberPriceCents).toBe(1250);
            expect(persisted.nonOrgMemberPriceCents).toBe(9999);
        });

        it('clears a price back to null when set to empty string', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

            const name = `${PROGRAM_NAME_TAG} patch clear`;
            const program = await prisma.program.create({
                data: { appliesToYear: 2026, name, leadMentorId: leadId, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), orgMemberPriceCents: 5000 },
            });

            const req = new Request(`http://localhost:4000/api/programs/${program.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ memberPrice: '' }),
            });
            const res = await PATCH(req as unknown as Request, { params: Promise.resolve({ id: String(program.id) }) });
            expect(res.status).toBe(200);

            const persisted = await prisma.program.findUniqueOrThrow({ where: { id: program.id } });
            expect(persisted.orgMemberPriceCents).toBeNull();
        });
    });
});
