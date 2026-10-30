/**
 * @jest-environment node
 */
/**
 * The Key Volunteer Agreement outside the role write: the caller's own status,
 * the Board's version bump, and who may record a signature by hand.
 */
import prisma from '@/lib/prisma';
import { POST as EXTERNAL_POST } from '@/app/api/membership-ops/applications/external/route';
import { bumpKeyVolunteerAgreementVersion, getKeyVolunteerSelfStatus } from '@/lib/membership/keyVolunteer';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

const TAG = 'kva-service-test';

function asSession(user: Record<string, unknown>) {
    (getServerSession as jest.Mock).mockResolvedValue({ user });
}

function markContract(processId: number) {
    return EXTERNAL_POST(new Request('http://localhost:4000/api/membership-ops/applications/external', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processId, action: 'mark-contract' }),
    }) as unknown as import('next/server').NextRequest);
}

describe('Key Volunteer Agreement service', () => {
    let boardId: number;
    let sysadminId: number;
    let signedId: number;
    let openId: number;
    let staleOpenProcessId: number;
    let versionBefore: number;
    let startedAt: Date;

    beforeAll(async () => {
        startedAt = new Date();
        const settings = await prisma.boardSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
        versionBefore = settings.keyVolunteerAgreementVersion;
        const person = (name: string, roles: ('BOARD' | 'SYSADMIN' | 'KEY_VOLUNTEER')[] = []) => prisma.person.create({
            data: {
                email: `${name}-${TAG}@example.com`, name, isBoardMember: roles.includes('BOARD'), isSysadmin: roles.includes('SYSADMIN'),
                household: { create: { name: `${TAG} ${name}` } },
                roles: { create: roles.map((role) => ({ role })) },
            },
        });
        boardId = (await person('board', ['BOARD'])).id;
        sysadminId = (await person('sysadmin', ['SYSADMIN'])).id;
        signedId = (await person('signed', ['KEY_VOLUNTEER'])).id;
        openId = (await person('open', ['KEY_VOLUNTEER'])).id;
        await prisma.orgMembershipProcess.create({
            data: { kind: 'KEY_VOLUNTEER_AGREEMENT', subjectPersonId: signedId, status: 'ACTIVE', agreementVersion: versionBefore, contractSignedAt: new Date() },
        });
        staleOpenProcessId = (await prisma.orgMembershipProcess.create({
            data: { kind: 'KEY_VOLUNTEER_AGREEMENT', subjectPersonId: openId, status: 'PENDING_EXTERNAL_ACTION', agreementVersion: versionBefore, zohoEnvelopeId: `env-${TAG}` },
        })).id;
    });

    afterAll(async () => {
        const people = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { id: true, householdId: true } });
        const ids = people.map((p) => p.id);
        // The bump opens an agreement for every Key Volunteer in the database; undo all it wrote.
        const opened = await prisma.orgMembershipProcess.findMany({
            where: { kind: 'KEY_VOLUNTEER_AGREEMENT', OR: [{ subjectPersonId: { in: ids } }, { agreementVersion: { gt: versionBefore }, createdAt: { gte: startedAt } }] },
            select: { id: true },
        });
        await prisma.auditLog.deleteMany({
            where: { OR: [{ actorId: { in: ids } }, { tableName: 'OrgMembershipProcess', affectedEntityId: { in: opened.map((p) => p.id) } }] },
        });
        await prisma.orgMembershipProcess.deleteMany({ where: { id: { in: opened.map((p) => p.id) } } });
        await prisma.boardSettings.update({ where: { id: 1 }, data: { keyVolunteerAgreementVersion: versionBefore } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: people.map((p) => p.householdId) } } });
    });

    it('reports the caller\'s own open agreement', async () => {
        expect(await getKeyVolunteerSelfStatus(openId)).toMatchObject({
            personId: openId, owesSignature: true, agreementVersion: versionBefore, requestStarted: true,
        });
        expect(await getKeyVolunteerSelfStatus(signedId)).toMatchObject({ personId: signedId, owesSignature: false });
    });

    it('records a signature by hand for a board member, never for a sysadmin while a board exists', async () => {
        asSession({ id: sysadminId, isSysadmin: true });
        expect((await markContract(staleOpenProcessId)).status).toBe(403);
        expect(await prisma.orgMembershipProcess.findUnique({ where: { id: staleOpenProcessId } })).toMatchObject({ status: 'PENDING_EXTERNAL_ACTION' });
    });

    it('a version bump archives older open agreements and asks every Key Volunteer to sign again', async () => {
        const result = await bumpKeyVolunteerAgreementVersion(boardId);
        expect(result.agreementVersion).toBe(versionBefore + 1);

        expect(await prisma.orgMembershipProcess.findUnique({ where: { id: staleOpenProcessId } })).toMatchObject({ status: 'ARCHIVED' });
        for (const personId of [signedId, openId]) {
            expect(await getKeyVolunteerSelfStatus(personId)).toMatchObject({ owesSignature: true, agreementVersion: versionBefore + 1, requestStarted: false });
            // Nobody loses the role.
            expect(await prisma.personRole.count({ where: { personId, role: 'KEY_VOLUNTEER' } })).toBe(1);
        }
        const holders = await prisma.personRole.count({ where: { role: 'KEY_VOLUNTEER', person: { mergedIntoId: null } } });
        expect(result.agreementsOpened).toBe(holders);
        expect(await prisma.auditLog.count({ where: { actorId: boardId, tableName: 'BoardSettings' } })).toBe(1);
    });

    it('a board member records the new agreement signed by hand', async () => {
        const open = await prisma.orgMembershipProcess.findFirstOrThrow({ where: { subjectPersonId: signedId, status: 'PENDING_EXTERNAL_ACTION' } });
        asSession({ id: boardId, isBoardMember: true });
        expect((await markContract(open.id)).status).toBe(200);
        expect(await prisma.orgMembershipProcess.findUnique({ where: { id: open.id } })).toMatchObject({ status: 'ACTIVE', zohoSignerPersonId: null });
        expect(await getKeyVolunteerSelfStatus(signedId)).toMatchObject({ owesSignature: false });
    });
});
