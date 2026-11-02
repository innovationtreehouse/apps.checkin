/**
 * @jest-environment node
 */
/**
 * Both person edit paths, the board's PUT /api/membership-ops/participants/[id] and
 * the household's PATCH /api/household/member, against real Postgres: the stored and
 * audited form of an address, the format check, and the refusal of a held address.
 */
import { PUT } from '@/app/api/membership-ops/participants/[id]/route';
import { PATCH } from '@/app/api/household/member/route';
import { EMAIL_IN_USE_REFUSAL } from '@/lib/household/emailInUse';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const TAG = 'person-email-edit-test';
const HELD = `held-${TAG}@example.com`;
const FRESH = `fresh-${TAG}@example.com`;
const MALFORMED = `not-an-address-${TAG}`;
const REASON = 'Asked by phone';

async function wipe() {
    const households = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = households.map((h) => h.id);
    await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
    await prisma.household.deleteMany({ where: { id: { in: ids } } });
}

function put(id: number, body: unknown) {
    const req = new Request(`http://localhost:4000/api/membership-ops/participants/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    return PUT(req as unknown as Parameters<typeof PUT>[0], { params: Promise.resolve({ id: String(id) }) });
}

function patch(body: unknown) {
    const req = new Request('http://localhost:4000/api/household/member', { method: 'PATCH', body: JSON.stringify(body) });
    return PATCH(req as unknown as Parameters<typeof PATCH>[0], { params: Promise.resolve({}) });
}

async function storedEmail(id: number) {
    return (await prisma.person.findUniqueOrThrow({ where: { id }, select: { email: true } })).email;
}

describe('person email edits', () => {
    let boardId: number;
    let leadId: number;
    let householdId: number;
    let targetId: number;

    beforeAll(async () => {
        await wipe();
        const board = await prisma.person.create({
            data: { email: `board-${TAG}@example.com`, name: 'Board', isBoardMember: true, household: { create: { name: `Board ${TAG}` } } },
        });
        boardId = board.id;
        await prisma.person.create({
            data: { email: HELD, name: 'Holder', household: { create: { name: `Holder ${TAG}` } } },
        });
        const household = await prisma.household.create({ data: { name: `Family ${TAG}` } });
        householdId = household.id;
        const lead = await prisma.person.create({
            data: { email: `lead-${TAG}@example.com`, name: 'Lead', householdId, isHouseholdLead: true },
        });
        leadId = lead.id;
    });

    beforeEach(async () => {
        const target = await prisma.person.create({
            data: { email: `target-${TAG}@example.com`, name: 'Target', householdId },
        });
        targetId = target.id;
    });

    afterEach(async () => {
        await prisma.person.deleteMany({ where: { id: targetId } });
    });

    afterAll(wipe);

    describe('on the board edit', () => {
        beforeEach(() => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isSysadmin: false, isBoardMember: true } });
        });

        it('stores and audits the lowercase, trimmed form', async () => {
            const res = await put(targetId, { email: ` ${FRESH.toUpperCase()} `, emailChangeReason: REASON });
            expect(res.status).toBe(200);
            expect(await storedEmail(targetId)).toBe(FRESH);

            const audit = await prisma.auditLog.findFirstOrThrow({
                where: { tableName: 'Person', affectedEntityId: targetId, action: 'EDIT' },
                orderBy: { id: 'desc' },
            });
            expect((audit.newData as { email?: string }).email).toBe(FRESH);
        });

        it('refuses a case variant of a held address, and keeps the linked sign-in', async () => {
            await prisma.account.create({ data: { userId: targetId, type: 'oauth', provider: 'google', providerAccountId: `${TAG}-sub` } });

            const res = await put(targetId, { email: HELD.toUpperCase(), emailChangeReason: REASON });

            expect(res.status).toBe(400);
            expect((await res.json()).error).toBe(EMAIL_IN_USE_REFUSAL);
            expect(await storedEmail(targetId)).toBe(`target-${TAG}@example.com`);
            expect(await prisma.account.count({ where: { userId: targetId } })).toBe(1);
        });

        it('refuses a malformed address', async () => {
            const res = await put(targetId, { email: MALFORMED, emailChangeReason: REASON });
            expect(res.status).toBe(400);
            expect(await storedEmail(targetId)).toBe(`target-${TAG}@example.com`);
        });

        it('refuses a non-string address', async () => {
            expect((await put(targetId, { email: 42, emailChangeReason: REASON })).status).toBe(400);
        });

        it('saves a record whose stored malformed address is resent unchanged', async () => {
            await prisma.person.update({ where: { id: targetId }, data: { email: MALFORMED } });
            const res = await put(targetId, { name: 'Renamed', email: MALFORMED });
            expect(res.status).toBe(200);
        });

        it('leaves a blank write as it was: a second blank collides and stays a 500', async () => {
            const other = await prisma.person.create({ data: { name: 'Other blank', householdId } });
            const logged = jest.spyOn(console, 'error').mockImplementation();
            try {
                expect((await put(targetId, { email: '', emailChangeReason: REASON })).status).toBe(200);
                expect(await storedEmail(targetId)).toBe('');
                expect((await put(other.id, { email: '', emailChangeReason: REASON })).status).toBe(500);
            } finally {
                logged.mockRestore();
                await prisma.person.deleteMany({ where: { id: other.id } });
            }
        });
    });

    describe('on the household edit', () => {
        beforeEach(() => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });
        });

        it('stores the lowercase, trimmed form', async () => {
            const res = await patch({ participantId: targetId, email: ` ${FRESH.toUpperCase()} ` });
            expect(res.status).toBe(200);
            expect(await storedEmail(targetId)).toBe(FRESH);
        });

        it('refuses a case variant of a held address', async () => {
            const res = await patch({ participantId: targetId, email: HELD.toUpperCase() });
            expect(res.status).toBe(400);
            expect((await res.json()).error).toBe(EMAIL_IN_USE_REFUSAL);
            expect(await storedEmail(targetId)).toBe(`target-${TAG}@example.com`);
        });

        it('refuses a malformed address', async () => {
            const res = await patch({ participantId: targetId, email: MALFORMED });
            expect(res.status).toBe(400);
            expect(await storedEmail(targetId)).toBe(`target-${TAG}@example.com`);
        });

        it('refuses a non-string address', async () => {
            expect((await patch({ participantId: targetId, email: 42 })).status).toBe(400);
        });

        it('saves a record whose stored malformed address is resent unchanged', async () => {
            await prisma.person.update({ where: { id: targetId }, data: { email: MALFORMED } });
            const res = await patch({ participantId: targetId, name: 'Renamed', email: MALFORMED });
            expect(res.status).toBe(200);
        });

        it('clears the address on a blank', async () => {
            const res = await patch({ participantId: targetId, email: '' });
            expect(res.status).toBe(200);
            expect(await storedEmail(targetId)).toBeNull();
        });
    });
});
