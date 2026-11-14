/**
 * @jest-environment node
 */
/**
 * An archived household refuses every change (HA-9): writes keyed by a household or
 * person id that row security does not reach answer 409, a role grant and an archive
 * racing each other cannot both commit, and unarchiving lifts the refusal.
 * Reads and writes as the DML role, so row security binds every query here.
 */
import { getServerSession } from 'next-auth/next';
import type { NextRequest } from 'next/server';
import type PrismaSingleton from '@/lib/prisma';
import type * as Archived from '@/lib/household/archived';
import type * as ArchiveAction from '@/lib/household/archiveAction';
import type * as Roles from '@/lib/roles';
import type * as Guard from '@/lib/household/archiveGuard';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/notifications', () => ({ sendNotification: jest.fn() }));

process.env.DATABASE_URL = process.env.DML_DATABASE_URL;

const TAG = `household-archive-writes-${Date.now()}`;

let prisma: typeof PrismaSingleton;
let withArchivedHouseholds: typeof Archived.withArchivedHouseholds;
let archiveHousehold: typeof ArchiveAction.archiveHousehold;
let unarchiveHousehold: typeof ArchiveAction.unarchiveHousehold;
let setRoleFlag: typeof Roles.setRoleFlag;
let ArchivedHouseholdError: typeof Guard.ArchivedHouseholdError;
let boardId: number;
const householdIds: number[] = [];
const programIds: number[] = [];

const asBoard = () => (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
const boardActor = () => ({ id: boardId, isBoardMember: true, isSysadmin: false });

let seq = 0;
async function household() {
    seq += 1;
    const person = await prisma.person.create({
        data: {
            email: `p${seq}-${TAG}@example.com`, name: `Member ${seq}`, isDeclaredAdult: true, isHouseholdLead: true,
            household: { create: { name: `HH ${seq} ${TAG}` } },
        },
    });
    householdIds.push(person.householdId);
    return { householdId: person.householdId, personId: person.id };
}

async function archivedHousehold() {
    const h = await household();
    await archiveHousehold(h.householdId, boardId);
    return h;
}

async function program() {
    const now = new Date();
    const p = await prisma.program.create({
        data: { name: `Program ${TAG}`, startAt: now, endAt: new Date(now.getTime() + 30 * 86400000), appliesToYear: now.getUTCFullYear(), enrollmentStatus: 'OPEN' },
    });
    programIds.push(p.id);
    return p;
}

function request(url: string, method: string, body?: unknown) {
    return new Request(`http://localhost:4000${url}`, { method, ...(body !== undefined && { body: JSON.stringify(body) }) }) as unknown as NextRequest;
}

async function expectArchivedRefusal(res: Response) {
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('archived');
}

beforeAll(async () => {
    prisma = (await import('@/lib/prisma')).default;
    ({ withArchivedHouseholds } = await import('@/lib/household/archived'));
    ({ archiveHousehold, unarchiveHousehold } = await import('@/lib/household/archiveAction'));
    ({ setRoleFlag } = await import('@/lib/roles'));
    ({ ArchivedHouseholdError } = await import('@/lib/household/archiveGuard'));
    const board = await prisma.person.create({
        data: { email: `board-${TAG}@example.com`, name: 'Board', isBoardMember: true, household: { create: { name: `Board HH ${TAG}` } } },
    });
    await prisma.personRole.create({ data: { personId: board.id, role: 'BOARD' } });
    boardId = board.id;
    householdIds.push(board.householdId);
});

afterAll(async () => {
    const people = await prisma.person.findMany({ where: { householdId: { in: householdIds } }, select: { id: true } });
    const personIds = people.map((p) => p.id);
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: personIds } }, { affectedEntityId: { in: [...personIds, ...householdIds] } }] } });
    await prisma.visit.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: householdIds } } } });
    await prisma.programParticipant.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.programVolunteer.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.program.deleteMany({ where: { id: { in: programIds } } });
    await prisma.personRole.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.orgMembership.deleteMany({ where: { householdId: { in: householdIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await withArchivedHouseholds((tx) => tx.household.deleteMany({ where: { id: { in: householdIds } } }));
});

describe('a role grant racing an archive', () => {
    it('makes the archive wait for the grant, which it then sees and refuses on', async () => {
        const { householdId, personId } = await household();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let signalLocked!: () => void;
        const locked = new Promise<void>((resolve) => { signalLocked = resolve; });

        const grant = prisma.$transaction(async (tx) => {
            await setRoleFlag(tx, personId, 'isKeyholder', true, boardActor());
            signalLocked();
            await gate;
        }, { timeout: 20000 });
        await locked;

        let settled = false;
        const archive = archiveHousehold(householdId, boardId).then(() => null, (e: unknown) => e).finally(() => { settled = true; });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(settled).toBe(false);

        release();
        await grant;
        expect(await archive).toMatchObject({ status: 409, message: expect.stringContaining('holds a role') });
        expect(await prisma.personRole.count({ where: { personId, role: 'KEYHOLDER' } })).toBe(1);
        expect(await prisma.household.findUnique({ where: { id: householdId } })).not.toBeNull();
    });

    it('refuses a grant that lands after the archive', async () => {
        const { personId } = await archivedHousehold();
        await expect(prisma.$transaction((tx) => setRoleFlag(tx, personId, 'isKeyholder', true, boardActor())))
            .rejects.toBeInstanceOf(ArchivedHouseholdError);
        expect(await prisma.personRole.count({ where: { personId } })).toBe(0);
    });
});

describe('writes to an archived household answer 409', () => {
    beforeEach(asBoard);

    it('PATCH /api/roles: a role grant', async () => {
        const { PATCH } = await import('@/app/api/roles/route');
        const { personId } = await archivedHousehold();
        await expectArchivedRefusal(await PATCH(request('/api/roles', 'PATCH', { targetUserId: personId, isKeyholder: true })));
    });

    it('POST /api/membership-ops/participants: adding someone to it', async () => {
        const { POST } = await import('@/app/api/membership-ops/participants/route');
        const { householdId } = await archivedHousehold();
        await expectArchivedRefusal(await POST(request('/api/membership-ops/participants', 'POST', { name: `Added ${TAG}`, householdId })));
        expect(await prisma.person.count({ where: { householdId } })).toBe(1);
    });

    it('POST /api/membership-ops/participants/[id]/household: moving a member out', async () => {
        const { POST } = await import('@/app/api/membership-ops/participants/[id]/household/route');
        const { householdId, personId } = await archivedHousehold();
        const res = await POST(request(`/api/membership-ops/participants/${personId}/household`, 'POST', { createNew: true }), { params: Promise.resolve({ id: String(personId) }) });
        await expectArchivedRefusal(res);
        expect((await prisma.person.findUniqueOrThrow({ where: { id: personId } })).householdId).toBe(householdId);
    });

    it('POST /api/programs/[id]/volunteers: a volunteer place', async () => {
        const { POST } = await import('@/app/api/programs/[id]/volunteers/route');
        const { personId } = await archivedHousehold();
        const { id } = await program();
        await expectArchivedRefusal(await POST(request(`/api/programs/${id}/volunteers`, 'POST', { participantId: personId }), { params: Promise.resolve({ id: String(id) }) }));
        expect(await prisma.programVolunteer.count({ where: { personId } })).toBe(0);
    });

    it('POST /api/programs/[id]/participants: an enrollment', async () => {
        const { POST } = await import('@/app/api/programs/[id]/participants/route');
        const { personId } = await archivedHousehold();
        const { id } = await program();
        const res = await POST(request(`/api/programs/${id}/participants`, 'POST', { participantId: personId, override: true }), { params: Promise.resolve({ id: String(id) }) });
        await expectArchivedRefusal(res);
        expect(await prisma.programParticipant.count({ where: { personId } })).toBe(0);
    });

    it('POST /api/facility/visits/insert: a manual visit', async () => {
        const { POST } = await import('@/app/api/facility/visits/insert/route');
        const { personId } = await archivedHousehold();
        const departedAt = new Date(Date.now() - 3600000);
        const arrivedAt = new Date(departedAt.getTime() - 3600000);
        const res = await POST(request('/api/facility/visits/insert', 'POST', { personId, arrivedAt: arrivedAt.toISOString(), departedAt: departedAt.toISOString() }));
        expect(res.status).toBe(409);
        expect(await prisma.visit.count({ where: { personId } })).toBe(0);
    });

    it('POST /api/membership-ops/households: a denial', async () => {
        const { POST } = await import('@/app/api/membership-ops/households/route');
        const { householdId } = await archivedHousehold();
        const res = await POST(request('/api/membership-ops/households', 'POST', { householdId, deny: true, reason: 'test' }));
        await expectArchivedRefusal(res);
        expect(await prisma.orgMembership.count({ where: { householdId } })).toBe(0);
    });

    it('POST /api/membership: its lead starting an application', async () => {
        const { POST } = await import('@/app/api/membership/route');
        const { householdId, personId } = await archivedHousehold();
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: personId } });
        await expectArchivedRefusal(await POST(request('/api/membership', 'POST')));
        expect(await prisma.orgMembership.count({ where: { householdId } })).toBe(0);
    });
});

describe('unarchive', () => {
    it('lifts the refusal', async () => {
        const { householdId, personId } = await archivedHousehold();
        await unarchiveHousehold(householdId, boardId);
        await prisma.$transaction((tx) => setRoleFlag(tx, personId, 'isKeyholder', true, boardActor()));
        expect(await prisma.personRole.count({ where: { personId, role: 'KEYHOLDER' } })).toBe(1);
    });
});
