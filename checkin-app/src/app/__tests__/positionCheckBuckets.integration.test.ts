/**
 * @jest-environment node
 */
/**
 * Naming a bucket owner or treasurer whose background check isn't current: the
 * Board's PUT answers 409 CHECK_ACKNOWLEDGEMENT_REQUIRED until the request
 * acknowledges it, then saves, audits the acknowledgement and emails the person
 * once. A current check, an under-18, a cleared owner and a removed treasurer
 * pass with no warning and no email. A failed email is a stuck item on the
 * Problems list until Retry sends it.
 */
import { PUT as OWNER_PUT } from '@/app/api/budget-owners/[id]/owner/route';
import { PUT as TREASURER_PUT, DELETE as TREASURER_DELETE } from '@/app/api/budget-owners/[id]/treasurers/[personId]/route';
import prisma from '@/lib/prisma';
import { sendEmail } from '@/lib/email';
import { retryProblem } from '@/lib/problems';
import { checkEmailStuckItems } from '@/lib/membership/positionCheck';
import { CHECK_ACKNOWLEDGEMENT_CODE } from '@/lib/membership/positionCheckCode';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/email', () => ({ ...jest.requireActual('@/lib/email'), sendEmail: jest.fn().mockResolvedValue(true) }));

const TAG = 'position-check-buckets';
const DAY = 86_400_000;
let restoreBoardSettings: () => Promise<void>;
let boardId: number;
let bucketSeq = 0;
let seq = 0;

function putOwner(bucketId: number, body: Record<string, unknown>) {
    return OWNER_PUT(new Request('http://localhost:4000/x', { method: 'PUT', body: JSON.stringify(body) }) as never, { params: Promise.resolve({ id: String(bucketId) }) });
}

function treasurer(method: 'PUT' | 'DELETE', bucketId: number, personId: number, body?: Record<string, unknown>) {
    const req = new Request('http://localhost:4000/x', { method, body: body === undefined ? undefined : JSON.stringify(body) }) as never;
    const ctx = { params: Promise.resolve({ id: String(bucketId), personId: String(personId) }) };
    return method === 'PUT' ? TREASURER_PUT(req, ctx) : TREASURER_DELETE(req, ctx);
}

async function person(fields: { lastBackgroundCheck?: Date | null; dateOfBirth?: Date } = {}) {
    seq += 1;
    return prisma.person.create({
        data: { email: `p${seq}-${TAG}@example.com`, name: `Approver ${seq}`, dateOfBirth: fields.dateOfBirth ?? new Date('1985-04-01'), lastBackgroundCheck: fields.lastBackgroundCheck ?? null, household: { create: { name: `${TAG} HH ${seq}` } } },
    });
}

async function bucket() {
    bucketSeq += 1;
    return prisma.budgetOwner.create({ data: { name: `${TAG} bucket ${bucketSeq}` } });
}

const acks = (personId: number) => prisma.auditLog.findMany({ where: { tableName: 'BG_CHECK_ACKNOWLEDGED', affectedEntityId: personId } });
const ownerOf = async (bucketId: number) => (await prisma.budgetOwner.findUniqueOrThrow({ where: { id: bucketId }, select: { ownerId: true } })).ownerId;
const isTreasurer = async (bucketId: number, personId: number) => (await prisma.budgetOwnerTreasurer.count({ where: { budgetOwnerId: bucketId, personId } })) === 1;

async function wipe() {
    const people = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { id: true, householdId: true } });
    const ids = people.map((p) => p.id);
    const buckets = (await prisma.budgetOwner.findMany({ where: { name: { contains: TAG } }, select: { id: true } })).map((b) => b.id);
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { affectedEntityId: { in: ids }, tableName: 'BG_CHECK_ACKNOWLEDGED' }] } });
    await prisma.budgetOwnerTreasurer.deleteMany({ where: { budgetOwnerId: { in: buckets } } });
    await prisma.budgetOwner.deleteMany({ where: { id: { in: buckets } } });
    await prisma.person.deleteMany({ where: { id: { in: ids } } });
    await prisma.household.deleteMany({ where: { id: { in: people.flatMap((p) => (p.householdId ? [p.householdId] : [])) } } });
}

beforeAll(async () => {
    restoreBoardSettings = await snapshotBoardSettings();
    const data = { bgRecheckMonths: 27, orgMembershipYearBoundary: new Date('2000-09-01T00:00:00Z') };
    await prisma.boardSettings.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
    await wipe();
    boardId = (await person({ lastBackgroundCheck: new Date() })).id;
});

afterAll(async () => {
    await wipe();
    await restoreBoardSettings();
    await prisma.$disconnect();
});

beforeEach(() => {
    jest.mocked(sendEmail).mockReset().mockResolvedValue(true);
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true, isSysadmin: false } });
});

describe('an owner without a current check', () => {
    it('needs the acknowledgement, then is named, audited and emailed once', async () => {
        const b = await bucket();
        const owner = await person();

        const first = await putOwner(b.id, { personId: owner.id });
        expect(first.status).toBe(409);
        expect((await first.json()).code).toBe(CHECK_ACKNOWLEDGEMENT_CODE);
        expect(await ownerOf(b.id)).toBeNull();
        expect(await acks(owner.id)).toHaveLength(0);
        expect(sendEmail).not.toHaveBeenCalled();

        const second = await putOwner(b.id, { personId: owner.id, acknowledgeCheck: true });
        expect(second.status).toBe(200);
        expect(await ownerOf(b.id)).toBe(owner.id);
        const [ack, ...more] = await acks(owner.id);
        expect(more).toHaveLength(0);
        expect(ack).toMatchObject({ actorId: boardId, action: 'CREATE', newData: { position: 'BUDGET_OWNER' } });
        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(jest.mocked(sendEmail).mock.calls[0][0]).toBe(owner.email);
        expect(jest.mocked(sendEmail).mock.calls[0][2]).toContain('Budget bucket owner');
    });

    it('is not warned about again when cleared', async () => {
        const b = await bucket();
        const owner = await person();
        expect((await putOwner(b.id, { personId: owner.id, acknowledgeCheck: true })).status).toBe(200);
        jest.mocked(sendEmail).mockClear();

        expect((await putOwner(b.id, { personId: null })).status).toBe(200);
        expect(await ownerOf(b.id)).toBeNull();
        expect(await acks(owner.id)).toHaveLength(1);
        expect(sendEmail).not.toHaveBeenCalled();
    });
});

describe('a treasurer without a current check', () => {
    it('needs the acknowledgement, then is added, audited and emailed once', async () => {
        const b = await bucket();
        const t = await person();

        const first = await treasurer('PUT', b.id, t.id);
        expect(first.status).toBe(409);
        expect((await first.json()).code).toBe(CHECK_ACKNOWLEDGEMENT_CODE);
        expect(await isTreasurer(b.id, t.id)).toBe(false);
        expect(sendEmail).not.toHaveBeenCalled();

        expect((await treasurer('PUT', b.id, t.id, { acknowledgeCheck: true })).status).toBe(200);
        expect(await isTreasurer(b.id, t.id)).toBe(true);
        const [ack, ...more] = await acks(t.id);
        expect(more).toHaveLength(0);
        expect(ack).toMatchObject({ actorId: boardId, newData: { position: 'BUDGET_TREASURER' } });
        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(jest.mocked(sendEmail).mock.calls[0][2]).toContain('Budget bucket treasurer');
    });

    it('is removed with no warning and no email', async () => {
        const b = await bucket();
        const t = await person();
        expect((await treasurer('PUT', b.id, t.id, { acknowledgeCheck: true })).status).toBe(200);
        jest.mocked(sendEmail).mockClear();

        expect((await treasurer('DELETE', b.id, t.id)).status).toBe(200);
        expect(await isTreasurer(b.id, t.id)).toBe(false);
        expect(await acks(t.id)).toHaveLength(1);
        expect(sendEmail).not.toHaveBeenCalled();
    });
});

it('names a person with a current check with no warning and no email', async () => {
    const b = await bucket();
    const current = await person({ lastBackgroundCheck: new Date() });
    expect((await putOwner(b.id, { personId: current.id })).status).toBe(200);
    expect((await treasurer('PUT', b.id, current.id)).status).toBe(200);
    expect(await acks(current.id)).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
});

it('never warns about an under-18', async () => {
    const b = await bucket();
    const youth = await person({ dateOfBirth: new Date(Date.now() - 12 * 365 * DAY) });
    expect((await treasurer('PUT', b.id, youth.id)).status).toBe(200);
    expect(sendEmail).not.toHaveBeenCalled();
});

describe('a failed email', () => {
    it('leaves the owner named and is stuck on the Problems list until Retry sends it', async () => {
        jest.mocked(sendEmail).mockResolvedValue(false);
        const b = await bucket();
        const owner = await person();
        expect((await putOwner(b.id, { personId: owner.id, acknowledgeCheck: true })).status).toBe(200);
        expect(await ownerOf(b.id)).toBe(owner.id);
        const [ack] = await acks(owner.id);
        const item = { library: 'background check', step: 'check email', id: String(ack.id) };
        expect(await checkEmailStuckItems()).toContainEqual(expect.objectContaining({ id: item.id, href: '/budgets' }));
        expect(sendEmail).toHaveBeenCalledTimes(1);

        jest.mocked(sendEmail).mockResolvedValue(true);
        await retryProblem(item, { userId: boardId, username: null });
        expect(await checkEmailStuckItems()).not.toContainEqual(expect.objectContaining({ id: item.id }));
        expect(sendEmail).toHaveBeenCalledTimes(2);
    });
});
