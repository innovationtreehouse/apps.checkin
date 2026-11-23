/**
 * @jest-environment node
 */
/**
 * Integration tests for PERSON_BG obligations: the new-member activation trigger
 * that OPENS the obligation, the subject-scoped
 * clear (stamps ONLY the subject person), and the two-reviewer gate keyed off the
 * SUBJECT's household. Warn-only — nothing blocks participation here.
 *
 * Modeled on renewalConcurrency / membershipReviewAPI / personBgComplianceAPI.
 */

import { attest, eligibleReviewProcessIds, ReviewError } from '@/lib/membership/review';
import { activate } from '@/lib/membership/payment';
import prisma from '@/lib/prisma';

// Congrats/reviewer pings must not hit Resend.
jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));

const TAG = 'person-bg-trigger-test';
const RECHECK_MONTHS = 12;
// Boundary anchored to Sept 1; nextBoundary() rolls it to the current/next year.
const BOUNDARY_SEED = new Date('2000-09-01');

/** Adult born long ago → ≥18 at any as-of date. */
const ADULT_DOB = new Date('1990-01-01');

async function makeHousehold(slug: string) {
    return prisma.household.create({ data: { name: `${TAG} ${slug}` } });
}

async function makePerson(slug: string, householdId: number, data: Partial<{ dateOfBirth: Date | null; lastBackgroundCheck: Date | null; isBackgroundCheckReviewer: boolean }> = {}) {
    return prisma.person.create({
        data: {
            email: `${slug}-${TAG}@example.com`,
            name: slug,
            householdId,
            dateOfBirth: data.dateOfBirth ?? null,
            lastBackgroundCheck: data.lastBackgroundCheck ?? null,
            isBackgroundCheckReviewer: data.isBackgroundCheckReviewer ?? false,
        },
    });
}

/** Attach a person to a fresh program as a participant so they count as program-attached. */
async function attachToProgram(slug: string, personId: number) {
    const program = await prisma.program.create({ data: { appliesToYear: 2026, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `${TAG} ${slug} program` } });
    await prisma.programParticipant.create({ data: { programId: program.id, personId } });
    return program.id;
}

function personBgCountFor(personId: number) {
    return prisma.orgMembershipProcess.count({ where: { kind: 'PERSON_BG', subjectPersonId: personId } });
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
        await prisma.backgroundCheckAttestation.deleteMany({ where: { processId: { in: pids } } });
        await prisma.programParticipant.deleteMany({ where: { programId: { in: progIds } } });
        await prisma.programVolunteer.deleteMany({ where: { programId: { in: progIds } } });
        await prisma.program.deleteMany({ where: { id: { in: progIds } } });
        await prisma.orgMembershipProcess.deleteMany({ where: { id: { in: pids } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }
}

async function setRecheckMonths(months: number) {
    await prisma.boardSettings.upsert({
        where: { id: 1 },
        create: { id: 1, bgRecheckMonths: months, orgMembershipYearBoundary: BOUNDARY_SEED },
        update: { bgRecheckMonths: months, orgMembershipYearBoundary: BOUNDARY_SEED },
    });
}

describe('PERSON_BG triggers + subject-scoped clear + gate', () => {
    let savedSettings: { bgRecheckMonths: number; orgMembershipYearBoundary: Date | null } | null = null;
    // Two distinct-household reviewers, both eligible (different households from any subject).
    let rev1 = 0, rev2 = 0;

    beforeAll(async () => {
        await cleanup();
        const prev = await prisma.boardSettings.findUnique({ where: { id: 1 } });
        savedSettings = prev ? { bgRecheckMonths: prev.bgRecheckMonths, orgMembershipYearBoundary: prev.orgMembershipYearBoundary } : null;
        await setRecheckMonths(RECHECK_MONTHS);

        const hhA = await makeHousehold('revA');
        const hhB = await makeHousehold('revB');
        rev1 = (await makePerson('rev1', hhA.id, { isBackgroundCheckReviewer: true })).id;
        rev2 = (await makePerson('rev2', hhB.id, { isBackgroundCheckReviewer: true })).id;
    });

    afterAll(async () => {
        await cleanup();
        // Unconditional: a row this suite created must go, or its boundary leaks into
        // suites that share this DB and expect none.
        if (savedSettings) await prisma.boardSettings.update({ where: { id: 1 }, data: savedSettings });
        else await prisma.boardSettings.delete({ where: { id: 1 } }).catch(() => {});
        await prisma.$disconnect();
    });

    it('new-member activation opens a PERSON_BG for an already-18 program-attached joiner', async () => {
        // New member: household activates (INITIAL, bg already cleared, now paying) with
        // a program-attached adult member → activation opens a PERSON_BG for that adult.
        const hh = await makeHousehold('joinerHh');
        const lead = await makePerson('joiner-lead', hh.id, { dateOfBirth: ADULT_DOB });
        await prisma.person.update({ where: { id: lead.id }, data: { isHouseholdLead: true } });
        const joiner = await makePerson('joiner-adult', hh.id, { dateOfBirth: ADULT_DOB });
        await attachToProgram('joiner', joiner.id);
        const membership = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
        const proc = await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: membership.id, kind: 'INITIAL', status: 'PENDING_PAYMENT', contractSignedAt: new Date(), bgClearedAt: new Date() },
        });

        await activate(proc.id, { via: 'manual', actorId: lead.id });

        expect((await prisma.orgMembership.findUnique({ where: { id: membership.id } }))?.status).toBe('ACTIVE');
        expect(await personBgCountFor(joiner.id)).toBe(1);

    });

    it('clearBackgroundCheck stamps ONLY the subject person — a household-mate is untouched', async () => {
        const hh = await makeHousehold('subjectHh');
        const subject = await makePerson('subject', hh.id, { dateOfBirth: ADULT_DOB });
        // A household-mate (also a lead) with no check — a blanket stamp would
        // hit them; the subject-scoped clear must NOT.
        const mate = await makePerson('mate', hh.id, { dateOfBirth: ADULT_DOB });
        await prisma.person.update({ where: { id: mate.id }, data: { isHouseholdLead: true } });
        // The subject's household has NO OrgMembership (a program lead in a non-member
        // household) — the gate must still work off the subject's household.
        const proc = await prisma.orgMembershipProcess.create({
            data: { kind: 'PERSON_BG', subjectPersonId: subject.id, orgMembershipId: null, status: 'PENDING_BG_REVIEW', bgConsentAt: new Date() },
        });

        // First distinct reviewer: not enough (2 required) → still awaiting.
        await attest(rev1, proc.id, { result: 'APPROVE' });
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: proc.id } }))?.status).toBe('PENDING_BG_REVIEW');

        // Second distinct reviewer clears it.
        await attest(rev2, proc.id, { result: 'APPROVE' });
        const after = await prisma.orgMembershipProcess.findUnique({ where: { id: proc.id } });
        expect(after?.bgClearedAt).not.toBeNull();

        const s = await prisma.person.findUnique({ where: { id: subject.id } });
        const m = await prisma.person.findUnique({ where: { id: mate.id } });
        expect(s?.lastBackgroundCheck).not.toBeNull(); // subject stamped
        expect(m?.lastBackgroundCheck).toBeNull(); // household-mate untouched (the safety assertion)
    });

    it('gate: a reviewer in the SUBJECT household is rejected (same_household_applicant)', async () => {
        const hh = await makeHousehold('subjRevHh');
        const subject = await makePerson('subj-rev-subject', hh.id, { dateOfBirth: ADULT_DOB });
        const insider = await makePerson('subj-rev-insider', hh.id, { isBackgroundCheckReviewer: true });
        const proc = await prisma.orgMembershipProcess.create({
            data: { kind: 'PERSON_BG', subjectPersonId: subject.id, orgMembershipId: null, status: 'PENDING_BG_REVIEW', bgConsentAt: new Date() },
        });
        await expect(attest(insider.id, proc.id, { result: 'APPROVE' })).rejects.toMatchObject({
            code: 'same_household_applicant',
        } as Partial<ReviewError>);
    });

    it('the reviewer queue lists a PERSON_BG only once submitted, and never a household application', async () => {
        // Subject in a household distinct from the reviewers → would otherwise be eligible.
        const subjHh = await makeHousehold('queueSubjHh');
        const subject = await makePerson('queue-subject', subjHh.id, { dateOfBirth: ADULT_DOB });
        const personBg = await prisma.orgMembershipProcess.create({
            data: { kind: 'PERSON_BG', subjectPersonId: subject.id, orgMembershipId: null, status: 'PENDING_BG_REVIEW' },
        });
        // A household application waiting on its check is decided by its people's reviews, not listed itself.
        const appHh = await makeHousehold('queueAppHh');
        const appLead = await makePerson('queue-app-lead', appHh.id);
        await prisma.person.update({ where: { id: appLead.id }, data: { isHouseholdLead: true } });
        const appMembership = await prisma.orgMembership.create({ data: { householdId: appHh.id, status: 'NONE' } });
        const household = await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: appMembership.id, kind: 'INITIAL', status: 'PENDING_PAYMENT', contractSignedAt: new Date(), bgConsentAt: new Date() },
        });

        expect(await eligibleReviewProcessIds(rev1)).not.toContain(personBg.id); // not submitted yet
        expect(await eligibleReviewProcessIds(rev1)).not.toContain(household.id);
        await prisma.orgMembershipProcess.update({ where: { id: personBg.id }, data: { bgConsentAt: new Date() } });
        expect(await eligibleReviewProcessIds(rev1)).toContain(personBg.id);
    });

    /** A household lead — a signing adult, whether or not they join a program. */
    async function makeLead(slug: string, householdId: number, data: Parameters<typeof makePerson>[2] = {}) {
        const p = await makePerson(slug, householdId, data);
        await prisma.person.update({ where: { id: p.id }, data: { isHouseholdLead: true } });
        return p;
    }

    it('new-member activation opens nothing for a second lead, but still opens for program-attached adults', async () => {
        const hh = await makeHousehold('secondLeadHh');
        // The household application cleared on the named lead's check; the second lead
        // holds none and is in no program, so they owe nothing of their own.
        const named = await makeLead('secondlead-named', hh.id, { dateOfBirth: ADULT_DOB, lastBackgroundCheck: new Date() });
        const secondLead = await makeLead('secondlead-unnamed', hh.id, { dateOfBirth: ADULT_DOB });
        const programAdult = await makePerson('secondlead-program-adult', hh.id, { dateOfBirth: ADULT_DOB });
        await attachToProgram('secondlead-program-adult', programAdult.id);
        const programLead = await makeLead('secondlead-program-lead', hh.id, { dateOfBirth: ADULT_DOB });
        await attachToProgram('secondlead-program-lead', programLead.id);
        const membership = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
        const proc = await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: membership.id, kind: 'INITIAL', status: 'PENDING_PAYMENT', contractSignedAt: new Date(), bgClearedAt: new Date() },
        });

        await activate(proc.id, { via: 'manual', actorId: named.id });

        expect((await prisma.orgMembership.findUnique({ where: { id: membership.id } }))?.status).toBe('ACTIVE');
        expect(await personBgCountFor(secondLead.id)).toBe(0);
        expect(await personBgCountFor(named.id)).toBe(0);
        expect(await personBgCountFor(programAdult.id)).toBe(1);
        expect(await personBgCountFor(programLead.id)).toBe(1);
    });

    it('gate: a REJECT moves the PERSON_BG to BLOCKED', async () => {
        const hh = await makeHousehold('rejectHh');
        const subject = await makePerson('reject-subject', hh.id, { dateOfBirth: ADULT_DOB });
        const proc = await prisma.orgMembershipProcess.create({
            data: { kind: 'PERSON_BG', subjectPersonId: subject.id, orgMembershipId: null, status: 'PENDING_BG_REVIEW', bgConsentAt: new Date() },
        });
        await attest(rev1, proc.id, { result: 'REJECT' });
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: proc.id } }))?.status).toBe('BLOCKED');
    });

    it('gate: attest refuses a PERSON_BG that has not been submitted (no consent) and records nothing', async () => {
        const hh = await makeHousehold('noConsentHh');
        const subject = await makePerson('noconsent-subject', hh.id, { dateOfBirth: ADULT_DOB });
        const proc = await prisma.orgMembershipProcess.create({
            data: { kind: 'PERSON_BG', subjectPersonId: subject.id, orgMembershipId: null, status: 'PENDING_BG_REVIEW' },
        });
        for (const result of ['APPROVE', 'REJECT'] as const) {
            await expect(attest(rev1, proc.id, { result })).rejects.toMatchObject({ code: 'wrong_phase' } as Partial<ReviewError>);
        }
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId: proc.id } })).toBe(0);
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: proc.id } }))?.status).toBe('PENDING_BG_REVIEW');
    });
});
