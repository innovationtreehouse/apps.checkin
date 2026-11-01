/**
 * @jest-environment node
 */
/**
 * What a board deny on POST /api/membership-ops/households does beyond the status:
 * trusted-adult access is revoked both ways and audited, program ties and mailing
 * lists go to the board's queue and stay in place, and a restore brings no
 * revoked trusted adult back.
 */

import { POST } from '@/app/api/membership-ops/households/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { DENIAL_REVOKE_REASON } from '@/lib/membership/denial';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

const TAG = 'deny-cascade-test';

function post(body: unknown) {
    return POST(new Request('http://localhost:4000/api/membership-ops/households', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest);
}

async function person(name: string, extra: { householdId?: number; isHouseholdLead?: boolean; isBoardMember?: boolean } = {}) {
    const { householdId, ...flags } = extra;
    return prisma.person.create({
        data: {
            email: `${name.toLowerCase().replace(/\s/g, '-')}-${TAG}@example.com`,
            name,
            ...flags,
            household: householdId ? { connect: { id: householdId } } : { create: { name: `${TAG} ${name}` } },
        },
    });
}

async function approvedTrustedAdult(householdId: number, disclosedById: number, trustedAdultPersonId: number | null, name: string) {
    return prisma.trustedAdult.create({
        data: {
            householdId, trustedAdultPersonId, trustedAdultName: name, trustedAdultPhone: '555-0100',
            familyContext: 'May collect the children.', disclosedById,
            reviews: { create: { householdId, kind: 'INITIAL', status: 'APPROVED', sharedNote: 'May collect.', effectiveFrom: new Date(), reviewBy: new Date(Date.now() + 86_400_000 * 300) } },
        },
        include: { reviews: true },
    });
}

const statuses = async (trustedAdultId: number) =>
    (await prisma.trustedAdultReview.findMany({ where: { trustedAdultId }, orderBy: { id: 'asc' } })).map((r) => r.status);

describe('POST /api/membership-ops/households — deny cascade', () => {
    let boardId: number;
    let deniedHh: number;
    let deniedLeadId: number;
    let deniedChildId: number;
    let otherLeadId: number;
    let unrelatedLeadId: number;
    let programId: number;
    let ownTaId: number;
    let elsewhereTaId: number;
    let unrelatedTaId: number;
    let personIds: number[] = [];

    beforeAll(async () => {
        const board = await person('Board Actor', { isBoardMember: true });
        boardId = board.id;

        const lead = await person('Denied Lead', { isHouseholdLead: true });
        deniedLeadId = lead.id;
        deniedHh = lead.householdId;
        deniedChildId = (await person('Denied Child', { householdId: deniedHh })).id;

        const otherLead = await person('Other Lead', { isHouseholdLead: true });
        otherLeadId = otherLead.id;
        const unrelatedLead = await person('Unrelated Lead', { isHouseholdLead: true });
        unrelatedLeadId = unrelatedLead.id;
        const unrelatedAdult = await person('Unrelated Adult');
        personIds = [boardId, deniedLeadId, deniedChildId, otherLeadId, unrelatedLeadId, unrelatedAdult.id];

        // (a) the denied household's own trusted adult.
        ownTaId = (await approvedTrustedAdult(deniedHh, deniedLeadId, null, 'Grandma')).id;
        // (b) the denied household's lead is trusted by another household.
        elsewhereTaId = (await approvedTrustedAdult(otherLead.householdId, otherLeadId, deniedLeadId, 'Denied Lead')).id;
        // Neither side touches the denied household.
        unrelatedTaId = (await approvedTrustedAdult(unrelatedLead.householdId, unrelatedLeadId, unrelatedAdult.id, 'Unrelated Adult')).id;

        const program = await prisma.program.create({
            data: { name: `${TAG} Robotics`, startAt: new Date('2026-09-01'), endAt: new Date('2027-05-31'), appliesToYear: 2026, phase: 'RUNNING' },
        });
        programId = program.id;
        await prisma.programParticipant.create({ data: { programId, personId: deniedChildId, status: 'ACTIVE' } });
        await prisma.programVolunteer.create({ data: { programId, personId: deniedLeadId } });
    });

    afterAll(async () => {
        const people = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { id: true, householdId: true } });
        const ids = people.map((p) => p.id);
        const households = people.map((p) => p.householdId);
        await prisma.paymentException.deleteMany({ where: { personId: { in: ids } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
        await prisma.programParticipant.deleteMany({ where: { programId } });
        await prisma.programVolunteer.deleteMany({ where: { programId } });
        await prisma.program.deleteMany({ where: { id: programId } });
        await prisma.trustedAdultReview.deleteMany({ where: { householdId: { in: households } } });
        await prisma.trustedAdult.deleteMany({ where: { householdId: { in: households } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: households } } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: households } } });
    });

    it('denies the household', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
        const res = await post({ householdId: deniedHh, deny: true, reason: 'safeguarding' });
        expect(res.status).toBe(200);
        expect((await prisma.orgMembership.findUnique({ where: { householdId: deniedHh } }))?.status).toBe('DENIED');
    });

    it('revokes the household\'s own trusted adults and its members trusted by others, and audits each', async () => {
        expect(await statuses(ownTaId)).toEqual(['REVOKED']);
        expect(await statuses(elsewhereTaId)).toEqual(['REVOKED']);

        for (const taId of [ownTaId, elsewhereTaId]) {
            const audit = await prisma.auditLog.findFirst({
                where: { tableName: 'TrustedAdult', affectedEntityId: taId, actorId: boardId },
                orderBy: { id: 'desc' },
            });
            expect(audit?.newData).toEqual(expect.objectContaining({ status: 'REVOKED', reason: DENIAL_REVOKE_REASON, deniedHouseholdId: deniedHh }));
            expect(audit?.oldData).toEqual(expect.objectContaining({ status: 'APPROVED' }));
        }
    });

    it('leaves an unrelated household\'s trusted adults alone', async () => {
        expect(await statuses(unrelatedTaId)).toEqual(['APPROVED']);
        expect(await prisma.auditLog.count({ where: { tableName: 'TrustedAdult', affectedEntityId: unrelatedTaId, actorId: boardId } })).toBe(0);
    });

    it('raises enrollments, program roles and mailing lists to the board without removing anything', async () => {
        const rows = await prisma.paymentException.findMany({
            where: { personId: { in: personIds }, kind: { in: ['DENIED_HOUSEHOLD_ENROLLMENT', 'DENIED_HOUSEHOLD_PROGRAM_ROLE', 'DENIED_HOUSEHOLD_MAILING_LISTS'] } },
            orderBy: { id: 'asc' },
        });
        expect(rows.map((r) => [r.kind, r.personId, r.programId, r.status])).toEqual([
            ['DENIED_HOUSEHOLD_ENROLLMENT', deniedChildId, programId, 'OPEN'],
            ['DENIED_HOUSEHOLD_PROGRAM_ROLE', deniedLeadId, programId, 'OPEN'],
            ['DENIED_HOUSEHOLD_MAILING_LISTS', deniedLeadId, null, 'OPEN'],
        ]);

        const enrollment = await prisma.programParticipant.findUnique({ where: { programId_personId: { programId, personId: deniedChildId } } });
        expect(enrollment?.status).toBe('ACTIVE');
        expect(await prisma.programVolunteer.count({ where: { programId, personId: deniedLeadId } })).toBe(1);
    });

    it('restoring the household brings no revoked trusted adult back', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
        const res = await post({ householdId: deniedHh, deny: false });
        expect(res.status).toBe(200);
        expect((await prisma.orgMembership.findUnique({ where: { householdId: deniedHh } }))?.status).toBe('NONE');

        expect(await statuses(ownTaId)).toEqual(['REVOKED']);
        expect(await statuses(elsewhereTaId)).toEqual(['REVOKED']);
    });
});
