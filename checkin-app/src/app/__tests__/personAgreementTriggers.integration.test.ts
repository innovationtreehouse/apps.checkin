/**
 * @jest-environment node
 */
/**
 * Integration tests for PERSON_AGREEMENT: the yearly re-sign population, the opens on
 * taking part, the per-year dedup by stored year, the year-end close, the Board's open
 * for the year it picks, and the signature completing it.
 *
 * These run against a real DB on purpose. The populations are nested relation filters
 * (household -> orgMembership -> status, spread with tookPartWhere), which type-check
 * whatever they select — only a real query proves they pick the right people.
 */

import {
    runPersonAgreementSweep,
    openPersonAgreementOnEngage,
    openPersonAgreementForNewMember,
    openPersonAgreementForBoard,
    findOpenPersonAgreement,
    membershipYearAt,
    previousMembershipYear,
    type DayWindow,
} from '@/lib/membership/personAgreementTriggers';
import { orgToday } from '@/lib/appSettings';
import { addHouseholdLead } from '@/lib/household/leads';
import { markContractSigned } from '@/lib/membership/external';
import prisma from '@/lib/prisma';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';

jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));

const TAG = 'person-agreement-trigger-test';
const BOUNDARY_SEED = new Date('2000-09-01');

/** Ages relative to the real clock, so no fixture changes age group on a future run. */
const yearsAgo = (n: number) => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear() - n, d.getUTCMonth(), d.getUTCDate()));
};
const AGE_20 = yearsAgo(20);
const AGE_17 = yearsAgo(17);
const AGE_30 = yearsAgo(30);
const NOW = new Date();
const daysAfter = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
type Span = { startAt: Date; endAt: Date };
// Set in beforeAll from the org's calendar day, which the triggers judge the year on.
let THIS_YEAR: DayWindow;
// The membership year a member household fixture has paid for: the one in progress.
let PAID_YEAR: number;
let IN_LAST_YEAR: Span;
let IN_THIS_YEAR: Span;
let TWO_YEARS_AGO: Span;

async function makeMemberHousehold(slug: string, membershipStatus: 'ACTIVE' | 'NONE' = 'ACTIVE') {
    const hh = await prisma.household.create({ data: { name: `${TAG} ${slug}` } });
    const membership = await prisma.orgMembership.create({ data: { householdId: hh.id, status: membershipStatus } });
    if (membershipStatus === 'ACTIVE') await payFor(membership.id, PAID_YEAR);
    return hh;
}

/** A settled application paying for membership year `year`. */
function payFor(orgMembershipId: number, year: number) {
    return prisma.orgMembershipProcess.create({
        data: { orgMembershipId, kind: 'RENEWAL', status: 'ACTIVE', membershipYear: year, appliesToYear: year, paidAt: new Date() },
    });
}

async function membershipOf(householdId: number) {
    return prisma.orgMembership.findUniqueOrThrow({ where: { householdId } });
}

function agreementsFor(personId: number) {
    return prisma.orgMembershipProcess.findMany({ where: { kind: 'PERSON_AGREEMENT', subjectPersonId: personId }, orderBy: { id: 'asc' } });
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

async function attachToProgram(slug: string, personId: number, dates: Span = IN_LAST_YEAR) {
    const program = await prisma.program.create({
        data: { appliesToYear: dates.startAt.getUTCFullYear(), name: `${TAG} ${slug} program`, startAt: dates.startAt, endAt: dates.endAt },
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
    let restoreBoardSettings: () => Promise<void> = async () => {};

    beforeAll(async () => {
        THIS_YEAR = membershipYearAt(BOUNDARY_SEED, await orgToday(NOW));
        PAID_YEAR = THIS_YEAR.start.getUTCFullYear();
        const lastYear = previousMembershipYear(THIS_YEAR);
        IN_LAST_YEAR = { startAt: daysAfter(lastYear.start, 10), endAt: daysAfter(lastYear.start, 60) };
        IN_THIS_YEAR = { startAt: THIS_YEAR.start, endAt: daysAfter(THIS_YEAR.end, -1) };
        TWO_YEARS_AGO = { startAt: daysAfter(lastYear.start, -300), endAt: daysAfter(lastYear.start, -200) };
        await cleanup();
        restoreBoardSettings = await snapshotBoardSettings();
        await setBoundary(BOUNDARY_SEED);
    });

    afterAll(async () => {
        await cleanup();
        await restoreBoardSettings();
        await prisma.$disconnect();
    });

    const CHILD = { dateOfBirth: AGE_20 };

    describe('yearly re-sign', () => {
        it('opens for an adult non-lead who took part last year, and nobody else', async () => {
            const hh = await makeMemberHousehold('cohort');
            const adultChild = await makePerson('cohort-adult-child', hh.id, CHILD);
            const grandparent = await makePerson('cohort-grandparent', hh.id, { isDeclaredAdult: true });
            const lead = await makePerson('cohort-lead', hh.id, { dateOfBirth: AGE_30, isHouseholdLead: true });
            const secondLead = await makePerson('cohort-second-lead', hh.id, { dateOfBirth: AGE_30, isHouseholdLead: true });
            const unknownAge = await makePerson('cohort-unknown-age', hh.id);
            const minor = await makePerson('cohort-minor', hh.id, { dateOfBirth: AGE_17 });
            for (const p of [adultChild, grandparent, lead, secondLead, unknownAge, minor]) await attachToProgram(`cohort-${p.id}`, p.id);
            const sittingOut = await makePerson('cohort-sitting-out', hh.id, CHILD);
            const nonMemberHh = await makeMemberHousehold('cohort-nonmember', 'NONE');
            const outsider = await makePerson('cohort-outsider', nonMemberHh.id, CHILD);
            await attachToProgram('cohort-outsider', outsider.id);

            await runPersonAgreementSweep(NOW);

            expect(await agreementCountFor(adultChild.id)).toBe(1);
            expect((await agreementsFor(adultChild.id))[0].membershipYear).toBe(PAID_YEAR); // the household's latest paid year
            expect(await agreementCountFor(grandparent.id)).toBe(1); // no age ceiling
            expect(await agreementCountFor(lead.id)).toBe(0); // signs the household agreement
            expect(await agreementCountFor(secondLead.id)).toBe(0); // a partner made a lead
            expect(await agreementCountFor(unknownAge.id)).toBe(0);
            expect(await agreementCountFor(minor.id)).toBe(0);
            expect(await agreementCountFor(sittingOut.id)).toBe(0); // didn't take part
            expect(await agreementCountFor(outsider.id)).toBe(0);
        });

        it('counts volunteering and leading as taking part', async () => {
            const hh = await makeMemberHousehold('roles');
            const volunteer = await makePerson('roles-volunteer', hh.id, CHILD);
            const leader = await makePerson('roles-leader', hh.id, CHILD);
            const program = await prisma.program.create({
                data: { appliesToYear: IN_LAST_YEAR.startAt.getUTCFullYear(), name: `${TAG} roles program`, ...IN_LAST_YEAR, leadMentorId: leader.id },
            });
            await prisma.programVolunteer.create({ data: { programId: program.id, personId: volunteer.id } });

            await runPersonAgreementSweep(NOW);

            expect(await agreementCountFor(volunteer.id)).toBe(1);
            expect(await agreementCountFor(leader.id)).toBe(1);
        });

        it('opens for someone taking part this year whose open on taking part was missed', async () => {
            const hh = await makeMemberHousehold('retry');
            const person = await makePerson('retry-child', hh.id, CHILD);
            await attachToProgram('retry', person.id, IN_THIS_YEAR);

            await runPersonAgreementSweep(NOW);

            expect(await agreementCountFor(person.id)).toBe(1);
        });

        it('skips someone whose only program was before last year', async () => {
            const hh = await makeMemberHousehold('lapsed');
            const person = await makePerson('lapsed-child', hh.id, CHILD);
            await attachToProgram('lapsed', person.id, TWO_YEARS_AGO);

            await runPersonAgreementSweep(NOW);

            expect(await agreementCountFor(person.id)).toBe(0);
        });

        it('is idempotent — a second nightly run opens nothing', async () => {
            const hh = await makeMemberHousehold('idem');
            const person = await makePerson('idem-child', hh.id, CHILD);
            await attachToProgram('idem', person.id);

            await runPersonAgreementSweep(NOW);
            const rerun = await runPersonAgreementSweep(NOW);

            expect(rerun.opened).toBe(0);
            expect(await agreementCountFor(person.id)).toBe(1);
        });

        it('a signed agreement is not re-opened in the same year, and is opened again the next year', async () => {
            const hh = await makeMemberHousehold('resign');
            const person = await makePerson('resign-child', hh.id, CHILD);
            await attachToProgram('resign', person.id);
            await runPersonAgreementSweep(NOW);
            const opened = await prisma.orgMembershipProcess.findFirstOrThrow({ where: { kind: 'PERSON_AGREEMENT', subjectPersonId: person.id } });
            await markContractSigned(opened.id, person.id);

            await runPersonAgreementSweep(NOW);
            expect(await agreementCountFor(person.id)).toBe(1);

            // A year on, this year's program is last year's; nothing new opens until the household pays for that year.
            await attachToProgram('resign-this-year', person.id, IN_THIS_YEAR);
            await runPersonAgreementSweep(daysAfter(THIS_YEAR.end, 1));
            expect(await agreementCountFor(person.id)).toBe(1);

            await payFor((await membershipOf(hh.id)).id, PAID_YEAR + 1);
            await runPersonAgreementSweep(daysAfter(THIS_YEAR.end, 1));
            expect((await agreementsFor(person.id)).map((a) => a.membershipYear)).toEqual([PAID_YEAR, PAID_YEAR + 1]);
        });

        it('opens the paid year once the household renews early, and does not ask again at the boundary', async () => {
            const hh = await makeMemberHousehold('early-renewal');
            const person = await makePerson('early-renewal-child', hh.id, CHILD);
            await attachToProgram('early-renewal', person.id, IN_THIS_YEAR);
            await payFor((await membershipOf(hh.id)).id, PAID_YEAR + 1);

            await runPersonAgreementSweep(NOW);
            const [opened] = await agreementsFor(person.id);
            expect(opened.membershipYear).toBe(PAID_YEAR + 1);
            await markContractSigned(opened.id, person.id);

            await runPersonAgreementSweep(daysAfter(THIS_YEAR.end, 1));
            expect(await agreementCountFor(person.id)).toBe(1);
        });

        it('opens nothing for a member household that has paid for no year', async () => {
            const hh = await prisma.household.create({ data: { name: `${TAG} unpaid` } });
            await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'ACTIVE' } });
            const person = await makePerson('unpaid-child', hh.id, CHILD);
            await attachToProgram('unpaid', person.id);

            await runPersonAgreementSweep(NOW);

            expect(await agreementCountFor(person.id)).toBe(0);
        });

        it('a signature for an earlier year does not count for the paid year', async () => {
            const hh = await makeMemberHousehold('earlier-year');
            const person = await makePerson('earlier-year-child', hh.id, CHILD);
            await attachToProgram('earlier-year', person.id);
            await prisma.orgMembershipProcess.create({
                data: { kind: 'PERSON_AGREEMENT', subjectPersonId: person.id, status: 'ACTIVE', membershipYear: PAID_YEAR - 1, contractSignedAt: new Date() },
            });

            await runPersonAgreementSweep(NOW);

            expect((await agreementsFor(person.id)).map((a) => a.membershipYear)).toEqual([PAID_YEAR - 1, PAID_YEAR]);
        });

        it('opens nothing when no membership-year boundary is configured', async () => {
            await setBoundary(null);
            const hh = await makeMemberHousehold('noboundary');
            const person = await makePerson('noboundary-child', hh.id, CHILD);
            await attachToProgram('noboundary', person.id);

            const result = await runPersonAgreementSweep(NOW);

            expect(result.opened).toBe(0);
            expect(await agreementCountFor(person.id)).toBe(0);
            await setBoundary(BOUNDARY_SEED);
        });
    });

    describe('year end', () => {
        it('closes an unsigned agreement once its year ends, and opens the paid year after', async () => {
            const hh = await makeMemberHousehold('year-end');
            const person = await makePerson('year-end-child', hh.id, CHILD);
            await attachToProgram('year-end', person.id, IN_THIS_YEAR);
            await runPersonAgreementSweep(NOW);
            const [open] = await agreementsFor(person.id);
            expect(open.membershipYear).toBe(PAID_YEAR);

            await payFor((await membershipOf(hh.id)).id, PAID_YEAR + 1);
            const result = await runPersonAgreementSweep(daysAfter(THIS_YEAR.end, 1));

            const [closed, next] = await agreementsFor(person.id);
            expect(closed).toMatchObject({ id: open.id, status: 'ARCHIVED', contractSignedAt: null });
            expect(next).toMatchObject({ status: 'PENDING_EXTERNAL_ACTION', membershipYear: PAID_YEAR + 1 });
            expect(result).toMatchObject({ closedAtYearEnd: 1, closeFailed: 0 });
            const audit = await prisma.auditLog.findFirstOrThrow({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: open.id, actorSystem: 'system:person-agreement-year-end' } });
            expect(audit.newData).toMatchObject({ status: 'ARCHIVED', reason: `closed unsigned at the end of ${PAID_YEAR}-${PAID_YEAR + 1}` });
        });

        it('leaves an agreement open while its year runs', async () => {
            const hh = await makeMemberHousehold('year-runs');
            const person = await makePerson('year-runs-child', hh.id, CHILD);
            await attachToProgram('year-runs', person.id, IN_THIS_YEAR);
            await runPersonAgreementSweep(NOW);

            await runPersonAgreementSweep(NOW);

            expect((await agreementsFor(person.id)).map((a) => a.status)).toEqual(['PENDING_EXTERNAL_ACTION']);
        });
    });

    describe('taking part', () => {
        it('opens for an adult non-lead with no agreement this year', async () => {
            const hh = await makeMemberHousehold('engage');
            const person = await makePerson('engage-child', hh.id, CHILD);

            await openPersonAgreementOnEngage(person.id, NOW);

            expect(await agreementCountFor(person.id)).toBe(1);
        });

        it('opens nothing for a lead, a minor or an unknown age', async () => {
            const hh = await makeMemberHousehold('engage-none');
            const lead = await makePerson('engage-lead', hh.id, { dateOfBirth: AGE_30, isHouseholdLead: true });
            const minor = await makePerson('engage-minor', hh.id, { dateOfBirth: AGE_17 });
            const unknownAge = await makePerson('engage-unknown-age', hh.id);

            for (const p of [lead, minor, unknownAge]) await openPersonAgreementOnEngage(p.id, NOW);

            for (const p of [lead, minor, unknownAge]) expect(await agreementCountFor(p.id)).toBe(0);
        });

        it('opens nothing when one was signed this year', async () => {
            const hh = await makeMemberHousehold('engage-signed');
            const person = await makePerson('engage-signed-child', hh.id, CHILD);
            const first = await openPersonAgreementOnEngage(person.id, NOW);
            await markContractSigned(first!.id, person.id);

            await openPersonAgreementOnEngage(person.id, NOW);

            expect(await agreementCountFor(person.id)).toBe(1);
        });

        it('activation opens one for a joining household whose adult non-lead takes part this year', async () => {
            const hh = await makeMemberHousehold('activation');
            const person = await makePerson('activation-child', hh.id, CHILD);
            await attachToProgram('activation', person.id, IN_THIS_YEAR);

            const activating = await prisma.orgMembershipProcess.create({
                data: { orgMembershipId: (await membershipOf(hh.id)).id, kind: 'INITIAL', status: 'ACTIVE', membershipYear: PAID_YEAR, appliesToYear: PAID_YEAR + 1, paidAt: NOW },
            });

            await openPersonAgreementForNewMember(hh.id, activating.id, NOW);

            const [opened] = await agreementsFor(person.id);
            expect(opened.membershipYear).toBe(PAID_YEAR + 1); // the year paid for, not the year applied for
        });
    });

    it('signing completes it outright — ACTIVE, no payment or BG gate', async () => {
        const hh = await makeMemberHousehold('signing');
        const person = await makePerson('signing-child', hh.id, CHILD);
        const opened = await openPersonAgreementOnEngage(person.id, NOW);
        expect(opened?.status).toBe('PENDING_EXTERNAL_ACTION');
        expect(opened?.orgMembershipId).toBeNull();

        const signed = await markContractSigned(opened!.id, person.id);

        expect(signed?.status).toBe('ACTIVE');
        expect(signed?.contractSignedAt).not.toBeNull();
        expect(signed?.paidAt).toBeNull();
        expect(signed?.bgClearedAt).toBeNull();
    });

    describe('made a household lead', () => {
        it('closes their open, unsigned agreement', async () => {
            const hh = await makeMemberHousehold('promote-open');
            const person = await makePerson('promote-open-adult', hh.id, CHILD);
            const opened = await openPersonAgreementOnEngage(person.id, NOW);

            await addHouseholdLead(prisma, hh.id, person.id);

            const closed = await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: opened!.id } });
            expect(closed.status).toBe('ARCHIVED');
            expect(await findOpenPersonAgreement(person.id)).toBeNull();
        });

        it('leaves a signed agreement alone', async () => {
            const hh = await makeMemberHousehold('promote-signed');
            const person = await makePerson('promote-signed-adult', hh.id, CHILD);
            const opened = await openPersonAgreementOnEngage(person.id, NOW);
            await markContractSigned(opened!.id, person.id);

            await addHouseholdLead(prisma, hh.id, person.id);

            const kept = await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: opened!.id } });
            expect(kept.status).toBe('ACTIVE');
            expect(kept.contractSignedAt).not.toBeNull();
        });
    });

    describe('Board open', () => {
        it('reaches any adult non-lead: an unknown age, an over-25, someone in no program', async () => {
            const hh = await makeMemberHousehold('manual-any');
            const unknownAge = await makePerson('manual-unknown-age', hh.id);
            const declared = await makePerson('manual-declared', hh.id, { isDeclaredAdult: true });
            const unattached = await makePerson('manual-unattached', hh.id, { dateOfBirth: AGE_30 });

            for (const p of [unknownAge, declared, unattached]) {
                const process = await openPersonAgreementForBoard(p.id, 1, PAID_YEAR + 1);
                expect(process.kind).toBe('PERSON_AGREEMENT');
                expect(process.status).toBe('PENDING_EXTERNAL_ACTION');
                expect(process.membershipYear).toBe(PAID_YEAR + 1); // the Board's pick
            }
        });

        it('refuses a household lead — an open one would shadow their household signing flow', async () => {
            const hh = await makeMemberHousehold('manual-lead');
            const lead = await makePerson('manual-lead-person', hh.id, { dateOfBirth: AGE_30, isHouseholdLead: true });

            await expect(openPersonAgreementForBoard(lead.id, 1, PAID_YEAR)).rejects.toMatchObject({ code: 'is_lead' });
            expect(await agreementCountFor(lead.id)).toBe(0);
        });

        it('refuses someone whose date of birth shows a minor', async () => {
            const hh = await makeMemberHousehold('manual-minor');
            const minor = await makePerson('manual-minor-person', hh.id, { dateOfBirth: AGE_17 });

            await expect(openPersonAgreementForBoard(minor.id, 1, PAID_YEAR)).rejects.toMatchObject({ code: 'minor' });
            expect(await agreementCountFor(minor.id)).toBe(0);
        });

        it('is idempotent — a second click returns the same obligation', async () => {
            const hh = await makeMemberHousehold('manual-idem');
            const person = await makePerson('manual-idem-child', hh.id, CHILD);

            const first = await openPersonAgreementForBoard(person.id, 1, PAID_YEAR);
            const second = await openPersonAgreementForBoard(person.id, 1, PAID_YEAR);

            expect(second.id).toBe(first.id);
            expect(await agreementCountFor(person.id)).toBe(1);
        });
    });
});
