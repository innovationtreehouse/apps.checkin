/**
 * @jest-environment node
 */
/**
 * Integration tests for PERSON_AGREEMENT: the nightly population predicate, the
 * per-cycle dedup, the manual board open, and the signature completing the obligation.
 *
 * These run against a real DB on purpose. The population is a nested relation filter
 * (household -> orgMembership -> status, spread with programAttachedWhere), which
 * type-checks whatever it selects — only a real query proves it picks the right people.
 *
 * Modeled on personBgTriggers.integration.test.ts.
 */

import {
    runPersonAgreementSweep,
    openPersonAgreementForNewMember,
    openPersonAgreementForBoard,
    PersonAgreementError,
} from '@/lib/membership/personAgreementTriggers';
import { markContractSigned } from '@/lib/membership/external';
import prisma from '@/lib/prisma';

jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));

const TAG = 'person-agreement-trigger-test';
const BOUNDARY_SEED = new Date('2000-09-01');

/** Ages relative to the real clock, so no fixture ages past its band on a future run. */
const yearsAgo = (n: number) => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear() - n, d.getUTCMonth(), d.getUTCDate()));
};
const AGE_20 = yearsAgo(20);
const AGE_17 = yearsAgo(17);
const AGE_30 = yearsAgo(30);

async function makeMemberHousehold(slug: string, membershipStatus: 'ACTIVE' | 'NONE' = 'ACTIVE') {
    const hh = await prisma.household.create({ data: { name: `${TAG} ${slug}` } });
    await prisma.orgMembership.create({ data: { householdId: hh.id, status: membershipStatus } });
    return hh;
}

async function makePerson(
    slug: string,
    householdId: number,
    data: Partial<{ dateOfBirth: Date | null; isDeclaredAdult: boolean; isHouseholdLead: boolean }> = {},
) {
    return prisma.person.create({
        data: {
            email: `${slug}-${TAG}@example.com`,
            name: slug,
            householdId,
            dateOfBirth: data.dateOfBirth ?? null,
            isDeclaredAdult: data.isDeclaredAdult ?? false,
            isHouseholdLead: data.isHouseholdLead ?? false,
        },
    });
}

async function attachToProgram(slug: string, personId: number, dates: { startAt?: Date; endAt?: Date } = {}) {
    const program = await prisma.program.create({
        data: { name: `${TAG} ${slug} program`, startAt: dates.startAt ?? new Date('2026-01-01'), endAt: dates.endAt ?? new Date('2026-12-31') },
    });
    await prisma.programParticipant.create({ data: { programId: program.id, personId } });
    return program.id;
}

function agreementCountFor(personId: number) {
    return prisma.orgMembershipProcess.count({ where: { kind: 'PERSON_AGREEMENT', subjectPersonId: personId } });
}

async function cleanup() {
    const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = hhs.map((h) => h.id);
    const progs = await prisma.program.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const progIds = progs.map((p) => p.id);
    if (ids.length || progIds.length) {
        const procs = await prisma.orgMembershipProcess.findMany({
            where: { OR: [{ orgMembership: { householdId: { in: ids } } }, { subjectPerson: { householdId: { in: ids } } }] },
            select: { id: true },
        });
        const pids = procs.map((p) => p.id);
        await prisma.programParticipant.deleteMany({ where: { programId: { in: progIds } } });
        await prisma.programVolunteer.deleteMany({ where: { programId: { in: progIds } } });
        await prisma.program.deleteMany({ where: { id: { in: progIds } } });
        await prisma.orgMembershipProcess.deleteMany({ where: { id: { in: pids } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }
}

async function setBoundary(boundary: Date | null) {
    await prisma.boardSettings.upsert({
        where: { id: 1 },
        create: { id: 1, orgMembershipYearBoundary: boundary },
        update: { orgMembershipYearBoundary: boundary },
    });
}

describe('PERSON_AGREEMENT triggers', () => {
    let savedBoundary: Date | null = null;

    beforeAll(async () => {
        await cleanup();
        const prev = await prisma.boardSettings.findUnique({ where: { id: 1 } });
        savedBoundary = prev?.orgMembershipYearBoundary ?? null;
        await setBoundary(BOUNDARY_SEED);
    });

    afterAll(async () => {
        await cleanup();
        await setBoundary(savedBoundary);
        await prisma.$disconnect();
    });

    it('opens for an 18-25 non-lead in a member household, and nobody else', async () => {
        await setBoundary(BOUNDARY_SEED);
        const hh = await makeMemberHousehold('cohort');
        const adultChild = await makePerson('cohort-adult-child', hh.id, { dateOfBirth: AGE_20 });
        const lead = await makePerson('cohort-lead', hh.id, { dateOfBirth: AGE_30, isHouseholdLead: true });
        const spouse = await makePerson('cohort-spouse', hh.id, { isDeclaredAdult: true });
        const minor = await makePerson('cohort-minor', hh.id, { dateOfBirth: AGE_17 });
        for (const p of [adultChild, lead, spouse, minor]) await attachToProgram(`cohort-${p.id}`, p.id);
        // 18-25 and in the household, but in no program — out of scope (the board can
        // still request one by hand).
        const unattached = await makePerson('cohort-unattached', hh.id, { dateOfBirth: AGE_20 });
        // Same shape, but the household isn't a member.
        const nonMemberHh = await makeMemberHousehold('cohort-nonmember', 'NONE');
        const outsider = await makePerson('cohort-outsider', nonMemberHh.id, { dateOfBirth: AGE_20 });
        await attachToProgram('cohort-outsider', outsider.id);

        await runPersonAgreementSweep(new Date());

        expect(await agreementCountFor(adultChild.id)).toBe(1);
        expect(await agreementCountFor(lead.id)).toBe(0); // signs the household agreement
        expect(await agreementCountFor(spouse.id)).toBe(0); // over 25 ⇒ presumed spouse
        expect(await agreementCountFor(minor.id)).toBe(0); // can't be bound by their own signature
        expect(await agreementCountFor(unattached.id)).toBe(0);
        expect(await agreementCountFor(outsider.id)).toBe(0);
    });

    // Attachment rows are never cleared when a program ends, so an unbounded
    // attached-ever predicate would re-ask someone who took one class at 18 every cycle
    // until they age out of the band. The lookback is what stops that.
    it('stops asking once the only program ended more than a year ago', async () => {
        const monthsAgo = (n: number) => {
            const d = new Date();
            d.setUTCMonth(d.getUTCMonth() - n);
            return d;
        };
        const hh = await makeMemberHousehold('lapsed');
        const finishedLongAgo = await makePerson('lapsed-finished', hh.id, { dateOfBirth: AGE_20 });
        await attachToProgram('lapsed-old', finishedLongAgo.id, { startAt: monthsAgo(20), endAt: monthsAgo(14) });
        // Ended inside the lookback — still counts for one more cycle.
        const finishedRecently = await makePerson('lapsed-recent', hh.id, { dateOfBirth: AGE_20 });
        await attachToProgram('lapsed-recent', finishedRecently.id, { startAt: monthsAgo(10), endAt: monthsAgo(2) });
        // No end date at all reads as still running, which is the point of the NULL rule:
        // an ongoing program must not expire its own members out of the population.
        const ongoing = await makePerson('lapsed-ongoing', hh.id, { dateOfBirth: AGE_20 });
        await attachToProgram('lapsed-ongoing', ongoing.id);

        await runPersonAgreementSweep(new Date());

        expect(await agreementCountFor(finishedLongAgo.id)).toBe(0);
        expect(await agreementCountFor(finishedRecently.id)).toBe(1);
        expect(await agreementCountFor(ongoing.id)).toBe(1);
    });

    it('is idempotent — a second nightly run opens nothing', async () => {
        const hh = await makeMemberHousehold('idem');
        const person = await makePerson('idem-child', hh.id, { dateOfBirth: AGE_20 });
        await attachToProgram('idem', person.id);

        await runPersonAgreementSweep(new Date());
        expect(await agreementCountFor(person.id)).toBe(1);

        const rerun = await runPersonAgreementSweep(new Date());
        expect(rerun.opened).toBe(0);
        expect(await agreementCountFor(person.id)).toBe(1);
    });

    it('opens nothing when no membership-year boundary is configured', async () => {
        await setBoundary(null);
        const hh = await makeMemberHousehold('noboundary');
        const person = await makePerson('noboundary-child', hh.id, { dateOfBirth: AGE_20 });
        await attachToProgram('noboundary', person.id);

        const result = await runPersonAgreementSweep(new Date());

        expect(result.opened).toBe(0);
        expect(await agreementCountFor(person.id)).toBe(0);
        await setBoundary(BOUNDARY_SEED);
    });

    it('activation opens one for a joining household, without waiting for the nightly run', async () => {
        const hh = await makeMemberHousehold('activation');
        const person = await makePerson('activation-child', hh.id, { dateOfBirth: AGE_20 });
        await attachToProgram('activation', person.id);

        await openPersonAgreementForNewMember(hh.id, new Date());

        expect(await agreementCountFor(person.id)).toBe(1);
    });

    it('signing completes it outright — ACTIVE, no payment or BG gate', async () => {
        const hh = await makeMemberHousehold('signing');
        const person = await makePerson('signing-child', hh.id, { dateOfBirth: AGE_20 });
        await attachToProgram('signing', person.id);
        await runPersonAgreementSweep(new Date());

        const opened = await prisma.orgMembershipProcess.findFirstOrThrow({
            where: { kind: 'PERSON_AGREEMENT', subjectPersonId: person.id },
        });
        expect(opened.status).toBe('PENDING_EXTERNAL_ACTION');
        expect(opened.orgMembershipId).toBeNull();

        const signed = await markContractSigned(opened.id, person.id);

        expect(signed?.status).toBe('ACTIVE');
        expect(signed?.contractSignedAt).not.toBeNull();
        // Never touched the payment/BG track — those gates don't apply to a person process.
        expect(signed?.paidAt).toBeNull();
        expect(signed?.bgClearedAt).toBeNull();
    });

    it('a signed agreement is not re-opened by the next nightly run (same cycle)', async () => {
        const hh = await makeMemberHousehold('resign');
        const person = await makePerson('resign-child', hh.id, { dateOfBirth: AGE_20 });
        await attachToProgram('resign', person.id);
        await runPersonAgreementSweep(new Date());
        const opened = await prisma.orgMembershipProcess.findFirstOrThrow({
            where: { kind: 'PERSON_AGREEMENT', subjectPersonId: person.id },
        });
        await markContractSigned(opened.id, person.id);

        await runPersonAgreementSweep(new Date());

        expect(await agreementCountFor(person.id)).toBe(1);
    });

    describe('manual board open', () => {
        it('reaches an over-25 adult child the nightly rule skips', async () => {
            const hh = await makeMemberHousehold('manual-over25');
            const person = await makePerson('manual-over25-child', hh.id, { isDeclaredAdult: true });

            const process = await openPersonAgreementForBoard(person.id, 1);

            expect(process.kind).toBe('PERSON_AGREEMENT');
            expect(process.status).toBe('PENDING_EXTERNAL_ACTION');
            expect(await agreementCountFor(person.id)).toBe(1);
        });

        it('reaches someone in no program at all', async () => {
            const hh = await makeMemberHousehold('manual-unattached');
            const person = await makePerson('manual-unattached-child', hh.id, { dateOfBirth: AGE_20 });

            await openPersonAgreementForBoard(person.id, 1);

            expect(await agreementCountFor(person.id)).toBe(1);
        });

        it('refuses a household lead — an open one would shadow their household signing flow', async () => {
            const hh = await makeMemberHousehold('manual-lead');
            const lead = await makePerson('manual-lead-person', hh.id, { dateOfBirth: AGE_30, isHouseholdLead: true });

            await expect(openPersonAgreementForBoard(lead.id, 1)).rejects.toMatchObject({ code: 'is_lead' });
            expect(await agreementCountFor(lead.id)).toBe(0);
        });

        it('refuses an unknown age — fix the date of birth first', async () => {
            const hh = await makeMemberHousehold('manual-nodob');
            const person = await makePerson('manual-nodob-person', hh.id);

            await expect(openPersonAgreementForBoard(person.id, 1)).rejects.toBeInstanceOf(PersonAgreementError);
            expect(await agreementCountFor(person.id)).toBe(0);
        });

        it('is idempotent — a second click returns the same obligation', async () => {
            const hh = await makeMemberHousehold('manual-idem');
            const person = await makePerson('manual-idem-child', hh.id, { dateOfBirth: AGE_20 });

            const first = await openPersonAgreementForBoard(person.id, 1);
            const second = await openPersonAgreementForBoard(person.id, 1);

            expect(second.id).toBe(first.id);
            expect(await agreementCountFor(person.id)).toBe(1);
        });
    });
});
