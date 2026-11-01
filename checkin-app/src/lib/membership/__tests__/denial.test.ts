/**
 * @jest-environment node
 */
import type { TxClient } from '@/lib/db-client';
import { personActor } from '@/lib/auditActor';
import { applyHouseholdDenial, DENIAL_REVOKE_REASON } from '@/lib/membership/denial';
import { recordPaymentException } from '@/lib/finance/reconcile/exceptions';

jest.mock('@/lib/finance/reconcile/exceptions', () => ({
    recordPaymentException: jest.fn(),
}));
jest.mock('@/lib/membership/boardAlerts', () => ({ notifyBoardPaymentException: jest.fn() }));

const recordException = recordPaymentException as jest.MockedFunction<typeof recordPaymentException>;

const DENIED_HH = 10;
const LEAD = 101;
const CHILD = 102;

type Review = { id: number; trustedAdultId: number; status: string };

function fakeTx(opts: {
    adults: { id: number }[];
    reviews: Review[];
    enrollments?: { personId: number; programId: number }[];
    volunteers?: { personId: number; programId: number }[];
    programsLed?: { id: number; leadMentorId: number }[];
    instancesLed?: { programId: number; leadMentorId: number }[];
}) {
    const tx = {
        person: {
            findMany: jest.fn().mockResolvedValue([{ id: LEAD }, { id: CHILD }]),
            findFirst: jest.fn().mockResolvedValue({ id: LEAD }),
        },
        trustedAdult: { findMany: jest.fn().mockResolvedValue(opts.adults) },
        trustedAdultReview: {
            findMany: jest.fn(({ where }: { where: { trustedAdultId: number; status: { notIn: string[] } } }) =>
                Promise.resolve(opts.reviews.filter((r) => r.trustedAdultId === where.trustedAdultId && !where.status.notIn.includes(r.status)))),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        auditLog: { create: jest.fn().mockResolvedValue({}) },
        programParticipant: { findMany: jest.fn().mockResolvedValue(opts.enrollments ?? []), update: jest.fn(), updateMany: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
        programVolunteer: { findMany: jest.fn().mockResolvedValue(opts.volunteers ?? []), delete: jest.fn(), deleteMany: jest.fn() },
        program: { findMany: jest.fn().mockResolvedValue(opts.programsLed ?? []), update: jest.fn(), updateMany: jest.fn() },
        programInstance: { findMany: jest.fn().mockResolvedValue(opts.instancesLed ?? []), update: jest.fn(), updateMany: jest.fn() },
        $queryRaw: jest.fn().mockResolvedValue([]),
    };
    return { tx, client: tx as unknown as TxClient };
}

const actor = personActor(99);

beforeEach(() => {
    recordException.mockReset();
    let id = 500;
    recordException.mockImplementation(async (_db, kind) => ({ kind, severity: 'CRITICAL', exceptionId: ++id }));
});

describe('applyHouseholdDenial — trusted adults', () => {
    it('looks up both directions: the household\'s own records and its members trusted elsewhere', async () => {
        const { tx, client } = fakeTx({ adults: [], reviews: [] });
        await applyHouseholdDenial(client, DENIED_HH, actor);
        expect(tx.trustedAdult.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { OR: [{ householdId: DENIED_HH }, { trustedAdultPersonId: { in: [LEAD, CHILD] } }] },
        }));
    });

    it('revokes every live review on both sides and audits each with the actor and reason', async () => {
        const { tx, client } = fakeTx({
            adults: [{ id: 1 }, { id: 2 }],
            reviews: [
                { id: 11, trustedAdultId: 1, status: 'APPROVED' },
                { id: 12, trustedAdultId: 1, status: 'PENDING_BOARD_REVIEW' },
                { id: 21, trustedAdultId: 2, status: 'APPROVED' },
                { id: 22, trustedAdultId: 2, status: 'EXPIRED' },
            ],
        });

        const outcome = await applyHouseholdDenial(client, DENIED_HH, actor);

        expect(outcome.revokedReviewIds).toEqual([11, 12, 21, 22]);
        expect(tx.trustedAdultReview.updateMany).toHaveBeenCalledWith({ where: { id: { in: [11, 12] } }, data: { status: 'REVOKED' } });
        expect(tx.trustedAdultReview.updateMany).toHaveBeenCalledWith({ where: { id: { in: [21, 22] } }, data: { status: 'REVOKED' } });
        expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
        expect(tx.auditLog.create).toHaveBeenCalledTimes(4);
        expect(tx.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                actorId: 99,
                tableName: 'TrustedAdult',
                affectedEntityId: 2,
                oldData: { status: 'APPROVED', reviewId: 21 },
                newData: { status: 'REVOKED', reviewId: 21, reason: DENIAL_REVOKE_REASON, deniedHouseholdId: DENIED_HH },
            }),
        });
    });

    it('leaves already-revoked reviews and the board\'s own denials as they are', async () => {
        const { tx, client } = fakeTx({
            adults: [{ id: 1 }],
            reviews: [
                { id: 11, trustedAdultId: 1, status: 'REVOKED' },
                { id: 12, trustedAdultId: 1, status: 'DENIED' },
            ],
        });
        const outcome = await applyHouseholdDenial(client, DENIED_HH, actor);
        expect(outcome.revokedReviewIds).toEqual([]);
        expect(tx.trustedAdultReview.updateMany).not.toHaveBeenCalled();
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });
});

describe('applyHouseholdDenial — board items', () => {
    it('raises each enrollment, program role and the mailing lists to the board, and removes none of them', async () => {
        const { tx, client } = fakeTx({
            adults: [],
            reviews: [],
            enrollments: [{ personId: CHILD, programId: 7 }],
            volunteers: [{ personId: LEAD, programId: 8 }],
            programsLed: [{ id: 8, leadMentorId: LEAD }],
            instancesLed: [{ programId: 9, leadMentorId: LEAD }],
        });

        const outcome = await applyHouseholdDenial(client, DENIED_HH, actor);

        expect(recordException.mock.calls.map(([db, kind, ref]) => [db, kind, ref])).toEqual([
            [client, 'DENIED_HOUSEHOLD_ENROLLMENT', { personId: CHILD, programId: 7, severity: 'CRITICAL' }],
            [client, 'DENIED_HOUSEHOLD_PROGRAM_ROLE', { personId: LEAD, programId: 8, severity: 'CRITICAL' }],
            [client, 'DENIED_HOUSEHOLD_PROGRAM_ROLE', { personId: LEAD, programId: 9, severity: 'CRITICAL' }],
            [client, 'DENIED_HOUSEHOLD_MAILING_LISTS', { personId: LEAD, programId: null, severity: 'CRITICAL' }],
        ]);
        expect(outcome.boardItemIds).toHaveLength(4);
        for (const write of [
            tx.programParticipant.update, tx.programParticipant.updateMany, tx.programParticipant.delete, tx.programParticipant.deleteMany,
            tx.programVolunteer.delete, tx.programVolunteer.deleteMany,
            tx.program.update, tx.program.updateMany, tx.programInstance.update, tx.programInstance.updateMany,
        ]) {
            expect(write).not.toHaveBeenCalled();
        }
    });

    it('asks only for live enrollments in programs not yet finished', async () => {
        const { tx, client } = fakeTx({ adults: [], reviews: [] });
        await applyHouseholdDenial(client, DENIED_HH, actor);
        expect(tx.programParticipant.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { personId: { in: [LEAD, CHILD] }, status: { in: ['PENDING', 'ACTIVE'] }, program: { phase: { not: 'FINISHED' } } },
        }));
    });

    it('reports only rows it newly opened, so a re-raise stays quiet', async () => {
        recordException.mockResolvedValue(null);
        const { client } = fakeTx({ adults: [], reviews: [], enrollments: [{ personId: CHILD, programId: 7 }] });
        const outcome = await applyHouseholdDenial(client, DENIED_HH, actor);
        expect(outcome.boardItemIds).toEqual([]);
    });
});
