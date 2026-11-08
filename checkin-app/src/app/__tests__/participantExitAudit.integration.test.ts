/**
 * @jest-environment node
 */
/**
 * A participant exit and its audit row commit together. A removal's audit is the
 * only record that its order spent a seat (seatsSpentBy), so a failed audit
 * write rolls the exit back rather than leaving a removal nobody can count.
 */

import { deleteAndReleaseHold, withdrawParticipant } from '@/lib/program/capacity';
import prisma from '@/lib/prisma';
import { systemActor } from '@/lib/auditActor';

const TAG = 'exit-audit-tx-test';

describe('participant exit and its audit commit together', () => {
    let personId: number;
    let programId: number;

    async function wipe() {
        const people = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { id: true, householdId: true } });
        const ids = people.map((p) => p.id);
        const programs = await prisma.program.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const programIds = programs.map((p) => p.id);
        await prisma.auditLog.deleteMany({ where: { tableName: 'ProgramParticipant', secondaryAffectedEntity: { in: programIds } } });
        await prisma.programParticipant.deleteMany({ where: { programId: { in: programIds } } });
        await prisma.program.deleteMany({ where: { id: { in: programIds } } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: people.map((p) => p.householdId).filter((h): h is number => h !== null) } } });
    }

    beforeEach(async () => {
        await wipe();
        personId = (await prisma.person.create({ data: { email: `kid-${TAG}@example.com`, name: 'kid', household: { create: { name: TAG } } } })).id;
        programId = (await prisma.program.create({
            data: { appliesToYear: 2026, startAt: new Date('2026-01-01'), endAt: new Date('2027-12-31'), name: TAG, maxParticipants: 10 },
        })).id;
        await prisma.programParticipant.create({ data: { programId, personId, status: 'ACTIVE', shopifyOrderId: '9001' } });
    });

    afterAll(wipe);

    const failingAudit = async () => { throw new Error('audit write failed'); };
    const enrollment = () => prisma.programParticipant.findUnique({ where: { programId_personId: { programId, personId } } });
    const audits = () => prisma.auditLog.count({ where: { tableName: 'ProgramParticipant', secondaryAffectedEntity: programId } });

    it('keeps the row when a removal cannot write its audit', async () => {
        await expect(deleteAndReleaseHold(programId, personId, {}, undefined, { audit: failingAudit })).rejects.toThrow('audit write failed');

        expect((await enrollment())?.status).toBe('ACTIVE');
    });

    it('keeps the row ACTIVE when a withdrawal cannot write its audit', async () => {
        await expect(withdrawParticipant(programId, personId, {}, undefined, { audit: failingAudit })).rejects.toThrow('audit write failed');

        expect((await enrollment())?.status).toBe('ACTIVE');
    });

    it('commits the removal and its DELETE audit together', async () => {
        await deleteAndReleaseHold(programId, personId, {}, undefined, {
            audit: (tx, row) => tx.auditLog.create({
                data: { ...systemActor('cron:scholarship-grace-expiry'), action: 'DELETE', tableName: 'ProgramParticipant', affectedEntityId: personId, secondaryAffectedEntity: programId, oldData: row },
            }),
        });

        expect(await enrollment()).toBeNull();
        expect(await audits()).toBe(1);
    });
});
