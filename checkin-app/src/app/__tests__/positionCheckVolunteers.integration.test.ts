/**
 * @jest-environment node
 */
/**
 * Adding a program volunteer, or making one core, when their background check isn't
 * current: /api/programs/[id]/volunteers answers 409 CHECK_ACKNOWLEDGEMENT_REQUIRED
 * until the request acknowledges it, then saves, audits the acknowledgement and emails
 * the volunteer once. A failed email is a stuck item on the Problems list until Retry.
 */
import { DELETE, PATCH, POST } from '@/app/api/programs/[id]/volunteers/route';
import prisma from '@/lib/prisma';
import { sendEmail } from '@/lib/email';
import { retryProblem } from '@/lib/problems';
import { checkEmailStuckItems } from '@/lib/membership/positionCheck';
import { CHECK_ACKNOWLEDGEMENT_CODE } from '@/lib/membership/positionCheckCode';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/email', () => ({ ...jest.requireActual('@/lib/email'), sendEmail: jest.fn().mockResolvedValue(true) }));

const TAG = 'position-check-volunteers';
const DAY = 86_400_000;
let restoreBoardSettings: () => Promise<void>;
let boardId: number;
let programId: number;
let seq = 0;

type Handler = typeof POST;
function call(handler: Handler, method: string, body: Record<string, unknown>) {
    return handler(
        new Request(`http://localhost:4000/api/programs/${programId}/volunteers`, { method, body: JSON.stringify(body) }) as never,
        { params: Promise.resolve({ id: String(programId) }) } as never,
    );
}
const add = (body: Record<string, unknown>) => call(POST, 'POST', body);
const setCore = (body: Record<string, unknown>) => call(PATCH, 'PATCH', body);

async function person(fields: { lastBackgroundCheck?: Date | null; dateOfBirth?: Date | null } = {}) {
    seq += 1;
    return prisma.person.create({
        data: {
            email: `p${seq}-${TAG}@example.com`,
            name: `Volunteer ${seq}`,
            dateOfBirth: fields.dateOfBirth === undefined ? new Date('1985-04-01') : fields.dateOfBirth,
            lastBackgroundCheck: fields.lastBackgroundCheck ?? null,
            household: { create: { name: `${TAG} HH ${seq}` } },
        },
    });
}

/** A volunteer already on the program, not core. */
async function volunteer(fields: { lastBackgroundCheck?: Date | null } = {}) {
    const p = await person(fields);
    await prisma.programVolunteer.create({ data: { programId, personId: p.id, isCore: false } });
    return p;
}

const acks = (personId: number) => prisma.auditLog.findMany({ where: { tableName: 'BG_CHECK_ACKNOWLEDGED', affectedEntityId: personId }, orderBy: { id: 'asc' } });
const row = (personId: number) => prisma.programVolunteer.findUnique({ where: { programId_personId: { programId, personId } } });

async function wipe() {
    const people = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { id: true, householdId: true } });
    const ids = people.map((p) => p.id);
    const ackIds = (await prisma.auditLog.findMany({ where: { tableName: 'BG_CHECK_ACKNOWLEDGED', affectedEntityId: { in: ids } }, select: { id: true } })).map((a) => a.id);
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { tableName: 'BG_CHECK_EMAIL', affectedEntityId: { in: ackIds } }, { affectedEntityId: { in: ids }, tableName: { in: ['ProgramVolunteer', 'BG_CHECK_ACKNOWLEDGED'] } }] } });
    await prisma.programVolunteer.deleteMany({ where: { personId: { in: ids } } });
    await prisma.program.deleteMany({ where: { name: { contains: TAG } } });
    await prisma.person.deleteMany({ where: { id: { in: ids } } });
    await prisma.household.deleteMany({ where: { id: { in: people.flatMap((p) => (p.householdId ? [p.householdId] : [])) } } });
}

beforeAll(async () => {
    restoreBoardSettings = await snapshotBoardSettings();
    const data = { bgRecheckMonths: 27, orgMembershipYearBoundary: new Date('2000-09-01T00:00:00Z') };
    await prisma.boardSettings.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
    await wipe();
    boardId = (await person({ lastBackgroundCheck: new Date() })).id;
    programId = (await prisma.program.create({
        data: { name: `Robotics ${TAG}`, appliesToYear: 2026, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), phase: 'RUNNING' },
    })).id;
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

describe('adding a volunteer without a current check', () => {
    it('needs the acknowledgement, then adds, audits and emails once naming the program', async () => {
        const v = await person();

        const first = await add({ participantId: v.id });
        expect(first.status).toBe(409);
        expect((await first.json()).code).toBe(CHECK_ACKNOWLEDGEMENT_CODE);
        expect(await row(v.id)).toBeNull();
        expect(await acks(v.id)).toHaveLength(0);
        expect(sendEmail).not.toHaveBeenCalled();

        expect((await add({ participantId: v.id, acknowledgeCheck: true })).status).toBe(200);
        expect(await row(v.id)).toMatchObject({ isCore: false });
        const [ack, ...more] = await acks(v.id);
        expect(more).toHaveLength(0);
        expect(ack).toMatchObject({ actorId: boardId, action: 'CREATE', newData: { position: 'PROGRAM_VOLUNTEER', programId } });
        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(jest.mocked(sendEmail).mock.calls[0][0]).toBe(v.email);
        expect(jest.mocked(sendEmail).mock.calls[0][2]).toContain(`Volunteer for Robotics ${TAG}`);
    });

    it('counts an unknown age as adult', async () => {
        const v = await person({ dateOfBirth: null });
        expect((await add({ participantId: v.id })).status).toBe(409);
    });
});

describe('making a volunteer core without a current check', () => {
    it('needs the acknowledgement, then makes them core, audits and emails once', async () => {
        const v = await volunteer();

        const first = await setCore({ participantId: v.id, isCore: true });
        expect(first.status).toBe(409);
        expect((await first.json()).code).toBe(CHECK_ACKNOWLEDGEMENT_CODE);
        expect(await row(v.id)).toMatchObject({ isCore: false });

        expect((await setCore({ participantId: v.id, isCore: true, acknowledgeCheck: true })).status).toBe(200);
        expect(await row(v.id)).toMatchObject({ isCore: true });
        expect((await acks(v.id)).map((a) => a.newData)).toEqual([{ position: 'CORE_VOLUNTEER', programId }]);
        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(jest.mocked(sendEmail).mock.calls[0][2]).toContain(`Core volunteer for Robotics ${TAG}`);
    });

    it('asks nothing when they are already core, or when core is cleared', async () => {
        const v = await volunteer();
        await prisma.programVolunteer.update({ where: { programId_personId: { programId, personId: v.id } }, data: { isCore: true } });

        expect((await setCore({ participantId: v.id, isCore: true })).status).toBe(200);
        expect((await setCore({ participantId: v.id, isCore: false })).status).toBe(200);
        expect(await acks(v.id)).toHaveLength(0);
        expect(sendEmail).not.toHaveBeenCalled();
    });
});

it('asks nothing for a volunteer with a current check', async () => {
    const v = await person({ lastBackgroundCheck: new Date() });
    expect((await add({ participantId: v.id })).status).toBe(200);
    expect((await setCore({ participantId: v.id, isCore: true })).status).toBe(200);
    expect(await acks(v.id)).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
});

it('asks nothing for an under-18 volunteer', async () => {
    const v = await person({ dateOfBirth: new Date(Date.now() - 12 * 365 * DAY) });
    expect((await add({ participantId: v.id })).status).toBe(200);
    expect(sendEmail).not.toHaveBeenCalled();
});

it('asks nothing to remove a volunteer', async () => {
    const v = await volunteer();
    expect((await call(DELETE, 'DELETE', { participantId: v.id })).status).toBe(200);
    expect(await acks(v.id)).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
});

describe('a failed email', () => {
    it('is stuck on the Problems list, linked to the program, until Retry sends it', async () => {
        jest.mocked(sendEmail).mockResolvedValue(false);
        const v = await person();
        expect((await add({ participantId: v.id, acknowledgeCheck: true })).status).toBe(200);
        expect(await row(v.id)).not.toBeNull();
        const [ack] = await acks(v.id);
        const item = { library: 'background check', step: 'check email', id: String(ack.id) };
        expect(await checkEmailStuckItems()).toContainEqual(expect.objectContaining({ id: item.id, step: item.step, href: `/program-ops/programs/${programId}` }));

        jest.mocked(sendEmail).mockResolvedValue(true);
        await retryProblem(item, { userId: boardId, username: null });
        expect(await checkEmailStuckItems()).not.toContainEqual(expect.objectContaining({ id: item.id }));
        expect(sendEmail).toHaveBeenCalledTimes(2);
    });
});
