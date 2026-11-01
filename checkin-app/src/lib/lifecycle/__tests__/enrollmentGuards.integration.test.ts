/**
 * @jest-environment node
 */
/**
 * Runs every declared enrollment guard on Postgres, over every on-diagram row shape.
 * The guard must admit exactly its declared from-states, and each admitted row must
 * classify to its declared to-state afterwards.
 */
import prisma from '@/lib/prisma';
import {
    ENROLLMENT_GUARDS,
    ENROLLMENT_WRITES,
    classify,
    enumerateEnrollmentRows,
    toRow,
    type EnrollmentGuard,
    type EnrollmentRow,
    type EnrollmentWrite,
    type EnrollmentWriteName,
} from '@/lib/programs/enrollmentState';

const TAG = 'enrollment-guards-test';
const writes: Record<EnrollmentWriteName, EnrollmentWrite> = ENROLLMENT_WRITES;
const guards: Record<string, EnrollmentGuard> = ENROLLMENT_GUARDS;

describe('enrollment guards on real rows', () => {
    let programId: number;
    let personId: number;
    let householdId: number;

    beforeAll(async () => {
        const person = await prisma.person.create({
            data: { name: 'Guard Row', email: `${TAG}@example.com`, household: { create: { name: TAG } } },
        });
        personId = person.id;
        householdId = person.householdId;
        const program = await prisma.program.create({
            data: { appliesToYear: 2026, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: TAG, enrollmentStatus: 'OPEN' },
        });
        programId = program.id;
        await prisma.programParticipant.create({ data: { programId, personId, status: 'PENDING' } });
    });

    afterAll(async () => {
        await prisma.programParticipant.deleteMany({ where: { programId } });
        await prisma.program.delete({ where: { id: programId } });
        await prisma.person.delete({ where: { id: personId } });
        await prisma.household.delete({ where: { id: householdId } });
    });

    const key = () => ({ programId_personId: { programId, personId } });

    async function seed(shape: EnrollmentRow) {
        const now = new Date();
        await prisma.programParticipant.update({
            where: key(),
            data: {
                status: shape.status,
                isPaymentPlanRequested: shape.isPaymentPlanRequested,
                inventoryHeldAt: shape.inventoryHeldAt ? now : null,
                paymentPlanDeniedAt: shape.paymentPlanDeniedAt ? now : null,
            },
        });
    }

    it.each(Object.entries(guards))('%s admits its from-states and lands on its to-state', async (_name, guard) => {
        const admittedBy = guard.admittedBy ?? guard.steps[guard.steps.length - 1];
        const admitted = new Set<string>();
        const landed: Record<string, string | null> = {};
        for (const shape of enumerateEnrollmentRows()) {
            const from = classify(shape);
            if (from === null) continue;
            await seed(shape);
            let took = false;
            for (const step of guard.steps) {
                const { count } = await prisma.programParticipant.updateMany({
                    where: { programId, personId, ...writes[step].where },
                    data: writes[step].data(new Date()),
                });
                if (step === admittedBy) took = count > 0;
            }
            if (!took) continue;
            admitted.add(from);
            landed[from] = classify(toRow(await prisma.programParticipant.findUniqueOrThrow({ where: key() })));
        }
        expect([...admitted].sort()).toEqual([...guard.from].sort());
        expect(landed).toEqual(Object.fromEntries(guard.from.map((from) => [from, guard.to])));
    });
});
