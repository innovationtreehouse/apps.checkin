/**
 * @jest-environment node
 */
/**
 * Granting a role to someone whose background check isn't current: PATCH /api/roles
 * answers 409 CHECK_ACKNOWLEDGEMENT_REQUIRED until the request acknowledges it, then
 * grants the role, audits the acknowledgement and emails the grantee once. A failed
 * email is a stuck item on the Problems list until Retry sends it.
 */
import { PATCH } from '@/app/api/roles/route';
import prisma from '@/lib/prisma';
import { sendEmail } from '@/lib/email';
import { retryProblem } from '@/lib/problems';
import { checkEmailStuckItems, positionCheckThreshold } from '@/lib/membership/positionCheck';
import { CHECK_ACKNOWLEDGEMENT_CODE } from '@/lib/membership/positionCheckCode';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/email', () => ({ ...jest.requireActual('@/lib/email'), sendEmail: jest.fn().mockResolvedValue(true) }));

const TAG = 'position-check-roles';
const DAY = 86_400_000;
let restoreBoardSettings: () => Promise<void>;
let boardId: number;
let seq = 0;

function patch(body: Record<string, unknown>) {
    return PATCH(new Request('http://localhost:4000/api/roles', { method: 'PATCH', body: JSON.stringify(body) }) as never);
}

async function person(fields: { lastBackgroundCheck?: Date | null; dateOfBirth?: Date } = {}) {
    seq += 1;
    return prisma.person.create({
        data: { email: `p${seq}-${TAG}@example.com`, name: `Grantee ${seq}`, dateOfBirth: fields.dateOfBirth ?? new Date('1985-04-01'), lastBackgroundCheck: fields.lastBackgroundCheck ?? null, household: { create: { name: `${TAG} HH ${seq}` } } },
    });
}

const acks = (personId: number) => prisma.auditLog.findMany({ where: { tableName: 'BG_CHECK_ACKNOWLEDGED', affectedEntityId: personId } });
const holds = async (personId: number) => (await prisma.personRole.count({ where: { personId, role: 'KEYHOLDER' } })) === 1;
const dateOnly = (d: Date) => new Date(d.toISOString().slice(0, 10));

async function wipe() {
    const people = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { id: true, householdId: true } });
    const ids = people.map((p) => p.id);
    const ackIds = (await prisma.auditLog.findMany({ where: { tableName: 'BG_CHECK_ACKNOWLEDGED', affectedEntityId: { in: ids } }, select: { id: true } })).map((a) => a.id);
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { tableName: 'BG_CHECK_EMAIL', affectedEntityId: { in: ackIds } }, { affectedEntityId: { in: ids }, tableName: { in: ['PersonRole', 'BG_CHECK_ACKNOWLEDGED'] } }] } });
    await prisma.personRole.deleteMany({ where: { personId: { in: ids } } });
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

describe('a grantee without a current check', () => {
    it('needs the acknowledgement, then is granted, audited and emailed once', async () => {
        const grantee = await person();

        const first = await patch({ targetUserId: grantee.id, isKeyholder: true });
        expect(first.status).toBe(409);
        expect((await first.json()).code).toBe(CHECK_ACKNOWLEDGEMENT_CODE);
        expect(await holds(grantee.id)).toBe(false);
        expect(await acks(grantee.id)).toHaveLength(0);
        expect(sendEmail).not.toHaveBeenCalled();

        const second = await patch({ targetUserId: grantee.id, isKeyholder: true, acknowledgeCheck: true });
        expect(second.status).toBe(200);
        expect(await holds(grantee.id)).toBe(true);
        const [ack, ...more] = await acks(grantee.id);
        expect(more).toHaveLength(0);
        expect(ack).toMatchObject({ actorId: boardId, action: 'CREATE', newData: { position: 'KEYHOLDER' } });
        expect(ack.timestamp).toBeInstanceOf(Date);
        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(jest.mocked(sendEmail).mock.calls[0][0]).toBe(grantee.email);
        expect(await checkEmailStuckItems()).not.toContainEqual(expect.objectContaining({ id: String(ack.id) }));
    });

    it('gets one email naming every role granted in one save', async () => {
        const grantee = await person();
        expect((await patch({ targetUserId: grantee.id, isKeyholder: true, isOperations: true, acknowledgeCheck: true })).status).toBe(200);

        expect((await acks(grantee.id)).map((a) => (a.newData as { position: string }).position).sort()).toEqual(['KEYHOLDER', 'OPERATIONS']);
        expect(sendEmail).toHaveBeenCalledTimes(1);
        const html = jest.mocked(sendEmail).mock.calls[0][2];
        expect(html).toContain('Keyholder');
        expect(html).toContain('Operations');
    });

    it('is warned when the check lapsed before the yardstick date, by one day', async () => {
        const threshold = await positionCheckThreshold(prisma);
        const grantee = await person({ lastBackgroundCheck: dateOnly(new Date(threshold!.getTime() - DAY)) });
        expect((await patch({ targetUserId: grantee.id, isKeyholder: true })).status).toBe(409);
    });
});

describe('a grantee with a current check', () => {
    it('is granted with no warning and no email', async () => {
        const grantee = await person({ lastBackgroundCheck: new Date() });
        expect((await patch({ targetUserId: grantee.id, isKeyholder: true })).status).toBe(200);
        expect(await holds(grantee.id)).toBe(true);
        expect(await acks(grantee.id)).toHaveLength(0);
        expect(sendEmail).not.toHaveBeenCalled();
    });

    it('counts a check dated exactly on the yardstick date', async () => {
        const threshold = await positionCheckThreshold(prisma);
        const grantee = await person({ lastBackgroundCheck: dateOnly(threshold!) });
        expect((await patch({ targetUserId: grantee.id, isKeyholder: true })).status).toBe(200);
        expect(sendEmail).not.toHaveBeenCalled();
    });
});

it('never warns about an under-18 grantee', async () => {
    const grantee = await person({ dateOfBirth: new Date(Date.now() - 12 * 365 * DAY) });
    expect((await patch({ targetUserId: grantee.id, isKeyholder: true })).status).toBe(200);
    expect(sendEmail).not.toHaveBeenCalled();
});

describe('a failed email', () => {
    it('is stuck on the Problems list until Retry sends it', async () => {
        jest.mocked(sendEmail).mockResolvedValue(false);
        const grantee = await person();
        expect((await patch({ targetUserId: grantee.id, isKeyholder: true, acknowledgeCheck: true })).status).toBe(200);
        expect(await holds(grantee.id)).toBe(true);
        const [ack] = await acks(grantee.id);
        const item = { library: 'background check', step: 'check email', id: String(ack.id) };
        expect(await checkEmailStuckItems()).toContainEqual(expect.objectContaining({ id: item.id, step: item.step }));

        await expect(retryProblem(item, { userId: boardId, username: null })).rejects.toMatchObject({ status: 409 });
        expect(await checkEmailStuckItems()).toContainEqual(expect.objectContaining({ id: item.id }));

        jest.mocked(sendEmail).mockResolvedValue(true);
        await retryProblem(item, { userId: boardId, username: null });
        expect(await checkEmailStuckItems()).not.toContainEqual(expect.objectContaining({ id: item.id }));
        expect(sendEmail).toHaveBeenCalledTimes(3);

        await expect(retryProblem(item, { userId: boardId, username: null })).rejects.toMatchObject({ status: 404 });
        expect(sendEmail).toHaveBeenCalledTimes(3);
    });
});
