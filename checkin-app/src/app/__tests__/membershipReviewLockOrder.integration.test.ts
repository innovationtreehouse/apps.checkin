/**
 * @jest-environment node
 */
/**
 * Pairs of membership transactions that lock overlapping rows each complete, one after
 * the other, because every one takes its locks in the order lib/lockOrder.ts states.
 * A holder transaction on an outside connection keeps a row locked until both racers
 * wait, so each interleaving here is fixed rather than left to timing.
 */
import { POST as movePerson } from '@/app/api/membership-ops/participants/[id]/household/route';
import { POST as mergePeople } from '@/app/api/membership-ops/participants/merge/route';
import { attest, boardReopenWrongPersonClose, boardResetReview } from '@/lib/membership/review';
import { settleHouseholdBg } from '@/lib/membership/settleHouseholdBg';
import { archiveHousehold } from '@/lib/household/archiveAction';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));
jest.mock('@/lib/membership/boardAlerts', () => ({ notifyBoardPaidReject: jest.fn().mockResolvedValue(undefined), notifyBoardCheckRejected: jest.fn().mockResolvedValue(undefined), notifyBoardPaymentException: jest.fn().mockResolvedValue(undefined) }));

const TAG = 'review-lock-order-test';
let seq = 0;
let restoreBoardSettings: () => Promise<void> = async () => {};
let board: number;
let sysadmin: number;
let reviewer: number;

type Holder = Pick<typeof prisma, '$queryRaw'>;

/** Waits until `count` other backends of this database are waiting on a row lock. */
async function waitForBlocked(holder: Holder, count: number) {
    for (let i = 0; i < 200; i++) {
        // Postgres caches pg_stat_activity for the transaction unless the snapshot is cleared.
        await holder.$queryRaw`SELECT pg_stat_clear_snapshot()::text`;
        const [{ blocked }] = await holder.$queryRaw<{ blocked: number }[]>`
            SELECT count(*)::int AS blocked FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`;
        if (blocked >= count) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Never saw ${count} backends waiting on a lock.`);
}

/** Holds `hold`'s lock while `first` and then `second` queue behind it, then lets both run. */
async function race<A, B>(hold: (tx: Holder) => Promise<unknown>, first: () => Promise<A>, second: () => Promise<B>): Promise<[A, B]> {
    let a!: Promise<A>;
    let b!: Promise<B>;
    await prisma.$transaction(async (tx) => {
        await hold(tx);
        a = first();
        a.catch(() => {});
        await waitForBlocked(tx, 1);
        b = second();
        b.catch(() => {});
        await waitForBlocked(tx, 2);
    }, { timeout: 15000 });
    return [await a, await b];
}

const holdMembership = (householdId: number) => (tx: Holder) => tx.$queryRaw`SELECT id FROM "OrgMembership" WHERE "householdId" = ${householdId} FOR UPDATE`;
const holdPerson = (personId: number) => (tx: Holder) => tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${personId} FOR UPDATE`;

async function staff(label: string, flags: { isBoardMember?: boolean; isSysadmin?: boolean; isBackgroundCheckReviewer?: boolean }) {
    const household = await prisma.household.create({ data: { name: `${TAG} ${label} HH` } });
    return (await prisma.person.create({ data: { name: label, email: `${label}-${TAG}@example.com`, householdId: household.id, ...flags } })).id;
}

/** A family (a lead and an adult, with a membership), a second household, and an open check review of the adult. */
async function fixture() {
    const n = seq++;
    const home = await prisma.household.create({ data: { name: `${TAG} home ${n}` } });
    const away = await prisma.household.create({ data: { name: `${TAG} away ${n}` } });
    await prisma.orgMembership.createMany({ data: [{ householdId: home.id, status: 'NONE' }, { householdId: away.id, status: 'NONE' }] });
    await prisma.person.create({ data: { name: `Lead ${n}`, email: `lead-${n}-${TAG}@example.com`, householdId: home.id, isHouseholdLead: true, isDeclaredAdult: true } });
    const subject = await prisma.person.create({ data: { name: `Adult ${n}`, email: `adult-${n}-${TAG}@example.com`, householdId: home.id, isDeclaredAdult: true } });
    const lead = await prisma.person.findFirstOrThrow({ where: { householdId: home.id, isHouseholdLead: true } });
    const review = await prisma.orgMembershipProcess.create({ data: { kind: 'PERSON_BG', subjectPersonId: subject.id, status: 'PENDING_BG_REVIEW', bgConsentAt: new Date() } });
    return { homeId: home.id, awayId: away.id, leadId: lead.id, subjectId: subject.id, reviewId: review.id };
}

/** A household application at `status` on the family's membership. */
async function application(householdId: number, status: 'BLOCKED' | 'PENDING_EXTERNAL_ACTION') {
    const membership = await prisma.orgMembership.findUniqueOrThrow({ where: { householdId } });
    return (await prisma.orgMembershipProcess.create({ data: { orgMembershipId: membership.id, kind: 'INITIAL', status, contractSignedAt: new Date() } })).id;
}

function moveReq(personId: number, householdId: number) {
    return new Request(`http://localhost:4000/api/membership-ops/participants/${personId}/household`, {
        method: 'POST',
        body: JSON.stringify({ householdId }),
    }) as unknown as import('next/server').NextRequest;
}

async function wipe() {
    const households = await prisma.household.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    const ids = households.map((h) => h.id);
    const people = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { id: true } });
    const personIds = people.map((p) => p.id);
    const processes = await prisma.orgMembershipProcess.findMany({ where: { OR: [{ orgMembership: { householdId: { in: ids } } }, { subjectPersonId: { in: personIds } }, { requestedForHouseholdId: { in: ids } }] }, select: { id: true } });
    const processIds = processes.map((p) => p.id);
    await prisma.backgroundCheckAttestation.deleteMany({ where: { processId: { in: processIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ tableName: 'OrgMembershipProcess', affectedEntityId: { in: processIds } }, { actorId: { in: personIds } }] } });
    await prisma.paymentException.deleteMany({ where: { processId: { in: processIds } } });
    await prisma.orgMembershipProcess.deleteMany({ where: { id: { in: processIds } } });
    await prisma.personMerge.deleteMany({ where: { OR: [{ toId: { in: personIds } }, { fromId: { in: personIds } }] } });
    await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.household.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
    restoreBoardSettings = await snapshotBoardSettings();
    const data = { bgRecheckMonths: 29, orgMembershipYearBoundary: new Date(Date.now() + 30 * 86400_000) };
    await prisma.boardSettings.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
    await wipe();
    board = await staff('Board', { isBoardMember: true });
    sysadmin = await staff('Sysadmin', { isSysadmin: true });
    reviewer = await staff('Reviewer', { isBackgroundCheckReviewer: true });
});

beforeEach(() => {
    jest.mocked(getServerSession).mockResolvedValue({ user: { id: sysadmin, isSysadmin: true, isBoardMember: false } });
});

afterAll(async () => {
    await wipe();
    await restoreBoardSettings();
    await prisma.$disconnect();
});

describe('Board acts on a check review against a household move', () => {
    it('refuses a reset when the person moves household between its first read and its locked re-read', async () => {
        const f = await fixture();
        let reset!: Promise<unknown>;

        // The holder is the move: it holds the source household's row and has moved the person, uncommitted.
        await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "Household" WHERE id = ${f.homeId} FOR UPDATE`;
            await tx.person.update({ where: { id: f.subjectId }, data: { householdId: f.awayId } });
            reset = boardResetReview(f.reviewId, board, { reason: 'start over' });
            reset.catch(() => {});
            await waitForBlocked(tx, 1);
        }, { timeout: 15000 });

        await expect(reset).rejects.toMatchObject({ code: 'wrong_phase', message: expect.stringContaining('changed while it was being reviewed') });
        const review = await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: f.reviewId } });
        expect(review.status).toBe('PENDING_BG_REVIEW');
    });

    it('a reopen and a move of its person both complete, one after the other, with no deadlock', async () => {
        const f = await fixture();
        await boardResetReview(f.reviewId, board, { reason: 'the report is another person', closeAsWrongPerson: true });

        const [reopened, moved] = await race(
            holdPerson(f.subjectId),
            () => boardReopenWrongPersonClose(f.reviewId, board, 'it was them after all'),
            () => movePerson(moveReq(f.subjectId, f.awayId), { params: Promise.resolve({ id: String(f.subjectId) }) }),
        );

        expect(reopened).toEqual({ status: 'PENDING_BG_REVIEW' });
        expect(moved.status).toBe(200);
        expect((await prisma.person.findUniqueOrThrow({ where: { id: f.subjectId } })).householdId).toBe(f.awayId);
    });

    it('a reopen and a first decision naming the lead on the same unnamed review both complete', async () => {
        const f = await fixture();
        const unnamed = (await prisma.orgMembershipProcess.create({ data: { kind: 'PERSON_BG', requestedForHouseholdId: f.homeId, status: 'PENDING_BG_REVIEW', bgConsentAt: new Date() } })).id;
        await boardResetReview(unnamed, board, { reason: 'opened by mistake', closeAsWrongPerson: true });

        const [reopened, decided] = await race(
            holdPerson(f.leadId),
            () => boardReopenWrongPersonClose(unnamed, board, 'it was right after all'),
            () => attest(reviewer, unnamed, { result: 'APPROVE', subjectPersonIds: [f.leadId] }),
        );

        expect(reopened).toEqual({ status: 'PENDING_BG_REVIEW' });
        expect(decided).toEqual({ status: 'PENDING_BG_REVIEW', approvals: 1 });
        expect((await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: unnamed } })).subjectPersonId).toBe(f.leadId);
    });
});

describe('Household-application paths against the check settle', () => {
    it('a Board reset of a blocked household application and a settle of its household both complete', async () => {
        const f = await fixture();
        const appId = await application(f.homeId, 'BLOCKED');

        const [reset] = await race(
            holdMembership(f.homeId),
            () => boardResetReview(appId, board, { reason: 'start over' }),
            () => settleHouseholdBg(f.homeId),
        );

        expect(reset.status).not.toBe('BLOCKED');
    });

    it('archiving a household and a settle of it both complete', async () => {
        const f = await fixture();
        await prisma.orgMembershipProcess.delete({ where: { id: f.reviewId } });
        const appId = await application(f.homeId, 'PENDING_EXTERNAL_ACTION');

        const [, archived] = await race(
            holdMembership(f.homeId),
            () => settleHouseholdBg(f.homeId),
            () => archiveHousehold(f.homeId, board),
        );

        expect(archived.archivedAt).not.toBeNull();
        expect((await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: appId } })).status).toBe('ARCHIVED');
    });
});

describe('A person merge against a Board act on a review of a merged person', () => {
    it('a reset of the review and a merge of its person both complete', async () => {
        const f = await fixture();

        const [reset, merged] = await race(
            holdMembership(f.homeId),
            () => boardResetReview(f.reviewId, board, { reason: 'start over' }),
            () => mergePeople(new Request('http://localhost:4000/api/membership-ops/participants/merge', {
                method: 'POST',
                body: JSON.stringify({ keepId: f.leadId, mergeId: f.subjectId, fieldChoices: { name: 'keep', identity: 'keep' } }),
            }) as never),
        );

        expect(reset).toEqual({ status: 'PENDING_BG_REVIEW' });
        expect(merged.status).toBe(200);
        expect(await prisma.person.findUnique({ where: { id: f.subjectId } })).toBeNull();
    });
});
