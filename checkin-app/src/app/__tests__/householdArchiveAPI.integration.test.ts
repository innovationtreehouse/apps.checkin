/**
 * @jest-environment node
 */
/**
 * Board "Archive household" / "Unarchive" on POST /api/membership-ops/households/[id]/archive and /unarchive:
 * Board only, each refusal, what an archive closes, and that unarchive leaves it closed.
 * Reads and writes as the DML role, so row security binds every query here.
 */
import { getServerSession } from 'next-auth/next';
import type { NextRequest } from 'next/server';
import type PrismaSingleton from '@/lib/prisma';
import type * as ArchiveRoute from '@/app/api/membership-ops/households/[id]/archive/route';
import type * as Archived from '@/lib/household/archived';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

process.env.DATABASE_URL = process.env.DML_DATABASE_URL;

const TAG = `household-archive-api-${Date.now()}`;

let prisma: typeof PrismaSingleton;
let archivePOST: typeof ArchiveRoute.POST;
let unarchivePOST: typeof ArchiveRoute.POST;
let withArchivedHouseholds: typeof Archived.withArchivedHouseholds;
let boardId: number;
let sysadminId: number;
const householdIds: number[] = [];

function post(id: number, { archive }: { archive: boolean }) {
    const action = archive ? 'archive' : 'unarchive';
    return (archive ? archivePOST : unarchivePOST)(
        new Request(`http://localhost:4000/api/membership-ops/households/${id}/${action}`, { method: 'POST' }) as unknown as NextRequest,
        { params: Promise.resolve({ id: String(id) }) },
    );
}

const asBoard = () => (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

let seq = 0;
async function household(status?: 'NONE' | 'ACTIVE' | 'DENIED' | 'REVOKED') {
    seq += 1;
    const person = await prisma.person.create({
        data: { email: `p${seq}-${TAG}@example.com`, name: `Member ${seq}`, household: { create: { name: `HH ${seq} ${TAG}` } } },
    });
    householdIds.push(person.householdId);
    const membership = status ? await prisma.orgMembership.create({ data: { householdId: person.householdId, status } }) : null;
    return { householdId: person.householdId, personId: person.id, membershipId: membership?.id ?? 0 };
}

async function program() {
    const now = new Date();
    return prisma.program.create({
        data: { name: `Program ${TAG}`, startAt: now, endAt: new Date(now.getTime() + 30 * 86400000), appliesToYear: now.getUTCFullYear() },
    });
}

async function archivedAt(id: number) {
    return withArchivedHouseholds((tx) => tx.household.findUnique({ where: { id }, select: { archivedAt: true } }));
}

async function expectRefused(id: number, text: string) {
    asBoard();
    const res = await post(id, { archive: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain(text);
    expect((await archivedAt(id))?.archivedAt).toBeNull();
}

beforeAll(async () => {
    prisma = (await import('@/lib/prisma')).default;
    ({ POST: archivePOST } = await import('@/app/api/membership-ops/households/[id]/archive/route'));
    ({ POST: unarchivePOST } = await import('@/app/api/membership-ops/households/[id]/unarchive/route'));
    ({ withArchivedHouseholds } = await import('@/lib/household/archived'));
    const board = await prisma.person.create({
        data: { email: `board-${TAG}@example.com`, name: 'Board', isBoardMember: true, household: { create: { name: `Board HH ${TAG}` } } },
    });
    boardId = board.id;
    householdIds.push(board.householdId);
    const sysadmin = await prisma.person.create({
        data: { email: `sysadmin-${TAG}@example.com`, name: 'Sysadmin', isSysadmin: true, household: { create: { name: `Sysadmin HH ${TAG}` } } },
    });
    sysadminId = sysadmin.id;
    householdIds.push(sysadmin.householdId);
});

afterAll(async () => {
    const people = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { id: true } });
    const personIds = people.map((p) => p.id);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: personIds } } });
    await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: householdIds } } } });
    await prisma.orgMembershipProcess.deleteMany({ where: { subjectPersonId: { in: personIds } } });
    await prisma.programParticipant.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.programVolunteer.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.program.deleteMany({ where: { name: `Program ${TAG}` } });
    await prisma.personRole.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.orgMembership.deleteMany({ where: { householdId: { in: householdIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await withArchivedHouseholds((tx) => tx.household.deleteMany({ where: { id: { in: householdIds } } }));
});

describe('who may archive', () => {
    it('refuses a sysadmin who is not on the Board', async () => {
        const { householdId } = await household();
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: sysadminId, isSysadmin: true } });
        const res = await post(householdId, { archive: true });
        expect(res.status).toBe(403);
        expect((await archivedAt(householdId))?.archivedAt).toBeNull();
    });

    it('refuses a sysadmin who is not on the Board an unarchive', async () => {
        const { householdId } = await household();
        asBoard();
        expect((await post(householdId, { archive: true })).status).toBe(200);
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: sysadminId, isSysadmin: true } });
        expect((await post(householdId, { archive: false })).status).toBe(403);
        expect((await archivedAt(householdId))?.archivedAt).not.toBeNull();
    });
});

describe('archive refusals', () => {
    it('refuses a household with a current Treehouse membership', async () => {
        const { householdId } = await household('ACTIVE');
        await expectRefused(householdId, 'current Treehouse membership');
    });

    it('refuses a household with a current program enrollment', async () => {
        const { householdId, personId } = await household();
        await prisma.programParticipant.create({ data: { programId: (await program()).id, personId } });
        await expectRefused(householdId, 'enrolled in a program');
    });

    it('refuses a household whose member holds a role', async () => {
        const { householdId, personId } = await household();
        await prisma.personRole.create({ data: { personId, role: 'KEYHOLDER' } });
        await expectRefused(householdId, 'holds a role');
    });

    it('refuses a household whose member volunteers on a program not yet finished', async () => {
        const { householdId, personId } = await household();
        await prisma.programVolunteer.create({ data: { programId: (await program()).id, personId } });
        await expectRefused(householdId, 'volunteers on or leads');
    });

    it('refuses a denied household', async () => {
        const { householdId } = await household('DENIED');
        await expectRefused(householdId, 'denied household cannot be archived');
    });

    it('refuses while an application has a payment with no recorded refund', async () => {
        const { householdId, membershipId } = await household('NONE');
        await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: membershipId, kind: 'INITIAL', status: 'PENDING_BG_CLEARANCE', paidAt: new Date() },
        });
        await expectRefused(householdId, 'payment recorded');
    });

    it('treats a fee that bought a membership as settled', async () => {
        const { householdId, membershipId } = await household('REVOKED');
        await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: membershipId, kind: 'INITIAL', status: 'ACTIVE', paidAt: new Date() },
        });
        asBoard();
        expect((await post(householdId, { archive: true })).status).toBe(200);
    });
});

describe('archive and unarchive', () => {
    it('closes the open blocked application, keeps the rejection, ignores per-person kinds, and unarchive leaves it closed', async () => {
        const { householdId, personId, membershipId } = await household('NONE');
        const blocked = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: membershipId, kind: 'INITIAL', status: 'BLOCKED' } });
        const personBg = await prisma.orgMembershipProcess.create({ data: { kind: 'PERSON_BG', status: 'PENDING_BG_REVIEW', subjectPersonId: personId } });

        asBoard();
        const res = await post(householdId, { archive: true });
        expect(res.status).toBe(200);
        expect((await res.json()).household.archivedAt).not.toBeNull();

        // Row security now hides it from a read that did not opt in.
        expect(await prisma.household.findUnique({ where: { id: householdId } })).toBeNull();

        const closed = await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: blocked.id } });
        expect(closed).toMatchObject({ status: 'ARCHIVED', archivedFromStatus: 'BLOCKED' });
        expect((await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: personBg.id } })).status).toBe('PENDING_BG_REVIEW');

        const audits = await prisma.auditLog.findMany({ where: { actorId: boardId, OR: [{ tableName: 'Household', affectedEntityId: householdId }, { tableName: 'OrgMembershipProcess', affectedEntityId: blocked.id }] } });
        expect(audits.map((a) => [a.tableName, a.oldData])).toEqual(expect.arrayContaining([
            ['OrgMembershipProcess', { status: 'BLOCKED' }],
            ['Household', { archivedAt: null }],
        ]));

        asBoard();
        expect((await post(householdId, { archive: true })).status).toBe(409);

        asBoard();
        const undo = await post(householdId, { archive: false });
        expect(undo.status).toBe(200);
        expect((await prisma.household.findUnique({ where: { id: householdId } }))?.archivedAt).toBeNull();
        expect((await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: blocked.id } })).status).toBe('ARCHIVED');
    });

    it('archives a household with no membership record', async () => {
        const { householdId } = await household();
        asBoard();
        expect((await post(householdId, { archive: true })).status).toBe(200);
        expect((await archivedAt(householdId))?.archivedAt).not.toBeNull();
    });

    it('refuses to unarchive a household that is not archived', async () => {
        const { householdId } = await household();
        asBoard();
        expect((await post(householdId, { archive: false })).status).toBe(409);
    });
});
