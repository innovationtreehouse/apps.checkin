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
import type { Prisma } from '@/generated/prisma/client';
import { systemActor } from '@/lib/auditActor';
import { DELETE } from '@/app/api/programs/[id]/participants/route';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

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
                data: { ...systemActor('cron:nightly'), action: 'DELETE', tableName: 'ProgramParticipant', affectedEntityId: personId, secondaryAffectedEntity: programId, oldData: row },
            }),
        });

        expect(await enrollment()).toBeNull();
        expect(await audits()).toBe(1);
    });

    describe('DELETE /api/programs/[id]/participants', () => {
        let adminId: number;
        let restore: () => void = () => {};

        /** Make the audit write inside every transaction throw. */
        function breakTransactionAudits() {
            const fail = () => Promise.reject(new Error('audit write failed'));
            const realTransaction = prisma.$transaction.bind(prisma) as (fn: (tx: Prisma.TransactionClient) => unknown, options?: unknown) => unknown;
            const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: (tx: Prisma.TransactionClient) => unknown, options?: unknown) =>
                realTransaction((client) =>
                    fn(new Proxy(client, { get: (target, prop) => (prop === 'auditLog' ? { create: fail } : Reflect.get(target, prop)) })),
                options)) as unknown as typeof prisma.$transaction);
            return () => spy.mockRestore();
        }

        const remove = (mode: 'remove' | 'withdraw') => DELETE(
            new Request(`http://localhost:4000/api/programs/${programId}/participants`, {
                method: 'DELETE',
                body: JSON.stringify({ participantId: personId, mode }),
            }) as unknown as import('next/server').NextRequest,
            { params: Promise.resolve({ id: String(programId) }) } as unknown as never,
        );

        beforeEach(async () => {
            adminId = (await prisma.person.create({ data: { email: `admin-${TAG}@example.com`, name: 'admin', isSysadmin: true, household: { create: { name: TAG } } } })).id;
            await prisma.programParticipant.update({ where: { programId_personId: { programId, personId } }, data: { status: 'PENDING', shopifyOrderId: null } });
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });
            jest.spyOn(console, 'error').mockImplementation(() => {});
            restore = breakTransactionAudits();
        });

        afterEach(() => {
            restore();
            jest.restoreAllMocks();
        });

        it.each(['remove', 'withdraw'] as const)('answers 500 and keeps the place when its %s audit cannot be written', async (mode) => {
            const res = await remove(mode);
            expect(res.status).toBe(500);

            expect((await enrollment())?.status).toBe('PENDING');
            expect(await audits()).toBe(0);
        });
    });
});
