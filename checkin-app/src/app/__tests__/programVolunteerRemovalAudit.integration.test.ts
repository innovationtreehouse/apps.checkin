/**
 * @jest-environment node
 */
/**
 * Removing a program volunteer and its audit row commit together.
 * A trigger makes Postgres refuse the audit row for one volunteer, whichever
 * client writes it, so that removal must roll back with the refused row.
 */
import { DELETE } from '@/app/api/programs/[id]/volunteers/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import type { NextRequest } from 'next/server';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const TAG = 'volunteer-removal-audit-test';

const remove = (programId: number, participantId: number) =>
    DELETE(
        new Request(`http://localhost:4000/api/programs/${programId}/volunteers`, {
            method: 'DELETE',
            body: JSON.stringify({ participantId }),
        }) as unknown as NextRequest,
        { params: Promise.resolve({ id: String(programId) }) } as unknown as never,
    );

describe('volunteer removal commits with its audit row', () => {
    let actorId: number;
    let refusedId: number;
    let removedId: number;
    let programId: number;

    const volunteerRow = (personId: number) =>
        prisma.programVolunteer.findUnique({ where: { programId_personId: { programId, personId } } });
    const removalAudits = (personId: number) =>
        prisma.auditLog.findMany({
            where: { tableName: 'ProgramVolunteer', action: 'DELETE', affectedEntityId: personId, secondaryAffectedEntity: programId },
        });

    beforeAll(async () => {
        const person = (role: string, extra: object = {}) =>
            prisma.person.create({
                data: { email: `${role}-${TAG}@example.com`, name: role, ...extra, household: { create: { name: 'Test HH' } } },
            });
        const actor = await person('actor', { isSysadmin: true });
        actorId = actor.id;
        refusedId = (await person('refused')).id;
        removedId = (await person('removed')).id;
        programId = (await prisma.program.create({
            data: {
                name: `Program ${TAG}`,
                appliesToYear: 2026,
                startAt: new Date('2026-01-01'),
                endAt: new Date('2026-12-31'),
                phase: 'RUNNING',
                leadMentorId: actorId,
                volunteers: { create: [{ personId: refusedId, isCore: false }, { personId: removedId, isCore: false }] },
            },
        })).id;
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: actorId, isSysadmin: true } });

        await prisma.$executeRawUnsafe(`
            CREATE OR REPLACE FUNCTION volunteer_removal_audit_refuse() RETURNS trigger AS $$
            BEGIN RAISE EXCEPTION 'audit write refused'; END
            $$ LANGUAGE plpgsql`);
        await prisma.$executeRawUnsafe(`
            CREATE TRIGGER volunteer_removal_audit_refuse BEFORE INSERT ON "AuditLog"
            FOR EACH ROW WHEN (NEW."affectedEntityId" = ${refusedId} AND NEW."tableName" = 'ProgramVolunteer')
            EXECUTE FUNCTION volunteer_removal_audit_refuse()`);
    });

    beforeEach(() => {
        // The route logs the refused write; that error is this suite's premise.
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    afterAll(async () => {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS volunteer_removal_audit_refuse ON "AuditLog"');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS volunteer_removal_audit_refuse()');
        const ids = [actorId, refusedId, removedId];
        await prisma.programVolunteer.deleteMany({ where: { programId } });
        await prisma.program.deleteMany({ where: { id: programId } });
        await prisma.auditLog.deleteMany({ where: { actorId } });
        const people = await prisma.person.findMany({ where: { id: { in: ids } }, select: { householdId: true } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: people.map((p) => p.householdId) } } });
    });

    it('keeps the volunteer when the audit row is refused', async () => {
        const res = await remove(programId, refusedId);

        expect(res.status).toBe(500);
        expect(await volunteerRow(refusedId)).not.toBeNull();
        expect(await removalAudits(refusedId)).toHaveLength(0);
    });

    it('removes the volunteer and writes its audit row', async () => {
        const res = await remove(programId, removedId);

        expect(res.status).toBe(200);
        expect(await volunteerRow(removedId)).toBeNull();
        const audits = await removalAudits(removedId);
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({ actorId, actorSystem: null, oldData: expect.objectContaining({ personId: removedId, programId }) });
    });
});
