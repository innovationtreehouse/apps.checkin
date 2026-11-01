/**
 * @jest-environment node
 */
/**
 * A scholarship decision and its audit row commit together, and the row records
 * what the decision did. A trigger makes Postgres refuse one actor's audit rows,
 * whichever client writes them, so that actor's decisions must roll back.
 */
import { POST as approve } from '@/app/api/finance-ops/payment-plans/route';
import { POST as refuse } from '@/app/api/finance-ops/payment-plans/refuse/route';
import { POST as manualHold } from '@/app/api/finance-ops/payment-plans/manual-hold/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const TAG = 'scholarship-decision-audit-test';

const post = (body: unknown) => new Request('http://localhost/api/finance-ops/payment-plans', {
    method: 'POST',
    body: JSON.stringify(body),
});

describe('scholarship decisions and their audit rows', () => {
    let refusedActorId: number;
    let actorId: number;
    let applicantId: number;
    let programId: number;
    const householdIds: number[] = [];

    const key = () => ({ programId_personId: { programId, personId: applicantId } });
    const signInAs = (id: number) =>
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isBoardMember: true } });
    const request = (inventoryHeldAt: Date | null) => prisma.programParticipant.create({
        data: { programId, personId: applicantId, status: 'PENDING', isPaymentPlanRequested: true, pendingSince: new Date(), inventoryHeldAt },
    });
    const auditFor = (actor: number) => prisma.auditLog.findFirstOrThrow({
        where: { actorId: actor, tableName: 'ProgramParticipant', affectedEntityId: applicantId, secondaryAffectedEntity: programId },
        orderBy: { id: 'desc' },
    });

    beforeAll(async () => {
        const makePerson = async (label: string, isBoardMember: boolean) => {
            const person = await prisma.person.create({
                data: { email: `${label}-${TAG}@example.com`, name: label, isBoardMember, household: { create: { name: 'Test HH' } } },
            });
            householdIds.push(person.householdId);
            return person.id;
        };
        refusedActorId = await makePerson('refused', true);
        actorId = await makePerson('actor', true);
        applicantId = await makePerson('applicant', false);

        const program = await prisma.program.create({
            data: { appliesToYear: 2026, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Program ${TAG}`, enrollmentStatus: 'OPEN', offSaleAt: new Date('2999-01-01') },
        });
        programId = program.id;

        await prisma.$executeRawUnsafe(`
            CREATE OR REPLACE FUNCTION scholarship_audit_refuse() RETURNS trigger AS $$
            BEGIN RAISE EXCEPTION 'audit write refused'; END
            $$ LANGUAGE plpgsql`);
        await prisma.$executeRawUnsafe(`
            CREATE TRIGGER scholarship_audit_refuse BEFORE INSERT ON "AuditLog"
            FOR EACH ROW WHEN (NEW."actorId" = ${refusedActorId})
            EXECUTE FUNCTION scholarship_audit_refuse()`);
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await prisma.programParticipant.deleteMany({ where: { programId } });
    });

    afterAll(async () => {
        await prisma.$executeRawUnsafe('DROP TRIGGER scholarship_audit_refuse ON "AuditLog"');
        await prisma.$executeRawUnsafe('DROP FUNCTION scholarship_audit_refuse()');
        await prisma.auditLog.deleteMany({ where: { actorId: { in: [refusedActorId, actorId] } } });
        await prisma.program.delete({ where: { id: programId } });
        await prisma.person.deleteMany({ where: { id: { in: [refusedActorId, actorId, applicantId] } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    });

    describe('a refused audit row rolls the decision back', () => {
        it.each([
            ['approve, held', approve, true],
            ['approve, hold failed', approve, false],
            ['deny, held', refuse, true],
            ['deny, hold failed', refuse, false],
            ['manual hold', manualHold, false],
        ])('%s', async (_label, route, held) => {
            // The routes log the refused write; that error is this suite's premise.
            jest.spyOn(console, 'error').mockImplementation(() => {});
            const inventoryHeldAt = held ? new Date('2026-06-01T00:00:00Z') : null;
            await request(inventoryHeldAt);
            signInAs(refusedActorId);

            const res = await route(post({ programId, participantId: applicantId }));

            expect(res.status).toBe(500);
            const row = await prisma.programParticipant.findUniqueOrThrow({ where: key() });
            expect(row).toMatchObject({
                status: 'PENDING',
                isPaymentPlanRequested: true,
                inventoryHeldAt,
                paymentPlanDeniedAt: null,
                seatTakenWithoutSaleAt: null,
            });
        });
    });

    describe('the audit row records what the approval did', () => {
        it('a held approval records the seat it took', async () => {
            await request(new Date());
            signInAs(actorId);

            const res = await approve(post({ programId, participantId: applicantId }));

            expect(res.status).toBe(200);
            const row = await prisma.programParticipant.findUniqueOrThrow({ where: key() });
            expect(row.seatTakenWithoutSaleAt).not.toBeNull();
            expect((await auditFor(actorId)).newData).toMatchObject({
                status: 'ACTIVE',
                seatTakenWithoutSaleAt: row.seatTakenWithoutSaleAt?.toISOString(),
            });
        });

        it('an approval with no hold records that no seat was held', async () => {
            await request(null);
            signInAs(actorId);

            const res = await approve(post({ programId, participantId: applicantId }));

            expect(res.status).toBe(200);
            const row = await prisma.programParticipant.findUniqueOrThrow({ where: key() });
            expect(row.seatTakenWithoutSaleAt).toBeNull();
            const { newData } = await auditFor(actorId);
            expect(newData).toMatchObject({ status: 'ACTIVE', reason: 'payment_plan_approved_no_hold' });
            expect(newData).not.toHaveProperty('seatTakenWithoutSaleAt');
        });
    });
});
