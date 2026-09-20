/**
 * @jest-environment node
 */
/**
 * Integration tests for Phase 2 PERSON_BG obligations: the two triggers that OPEN
 * the obligation (annual cohort + new-member activation), the subject-scoped
 * clear (stamps ONLY the subject person), and the two-reviewer gate keyed off the
 * SUBJECT's household. Warn-only — nothing blocks participation here.
 *
 * Modeled on renewalConcurrency / membershipReviewAPI / personBgComplianceAPI.
 */

import { runPersonBgAnnualSweep } from '@/lib/membership/personBgTriggers';
import { nextBoundary } from '@/lib/membership/renewal';
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

/**
 * The boundary the sweep itself will compute, and a DOB whose 18th birthday lands
 * two months past it → 17 as of the boundary → MINOR. Derived, never a literal:
 * nextBoundary() rolls with the real clock, so a fixed DOB ages past the boundary
 * on a date nobody wrote down. The age gate is boundary-inclusive (a birthday
 * exactly on the boundary counts as ≥18), hence the two-month margin.
 */
const BOUNDARY = nextBoundary(BOUNDARY_SEED, new Date());
const NOT_YET_18_DOB = new Date(Date.UTC(BOUNDARY.getUTCFullYear() - 18, BOUNDARY.getUTCMonth() + 2, BOUNDARY.getUTCDate()));

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
    const program = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `${TAG} ${slug} program` } });
    await prisma.programParticipant.create({ data: { programId: program.id, personId } });
    return program.id;
}

/** Attach a person to a program that ended well outside the 12-month lookback. */
async function attachToStaleProgram(slug: string, personId: number) {
    const program = await prisma.program.create({ data: { startAt: new Date('2020-01-01'), endAt: new Date('2020-12-31'), name: `${TAG} ${slug} program` } });
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

    it('Trigger A opens PERSON_BG only for ≥18-not-fresh program people, and re-running is idempotent', async () => {
        await setRecheckMonths(RECHECK_MONTHS);
        const hh = await makeHousehold('cohortA');
        const adult = await makePerson('cohort-adult', hh.id, { dateOfBirth: ADULT_DOB });
        // Turns 18 AFTER the boundary → 17 as of the boundary → MINOR, not opened.
        const notYet18 = await makePerson('cohort-notyet', hh.id, { dateOfBirth: NOT_YET_18_DOB });
        const fresh = await makePerson('cohort-fresh', hh.id, { dateOfBirth: ADULT_DOB, lastBackgroundCheck: new Date() });
        for (const p of [adult, notYet18, fresh]) await attachToProgram(`cohort-${p.id}`, p.id);
        // Not program-attached → out of scope even though ≥18.
        const unattached = await makePerson('cohort-unattached', hh.id, { dateOfBirth: ADULT_DOB });

        await runPersonBgAnnualSweep(new Date());
        expect(await personBgCountFor(adult.id)).toBe(1);
        expect(await personBgCountFor(notYet18.id)).toBe(0);
        expect(await personBgCountFor(fresh.id)).toBe(0);
        expect(await personBgCountFor(unattached.id)).toBe(0);

        // Idempotent: after one full sweep, every NEEDED person already has one, so a
        // second sweep opens nothing new (globally, not just for our fixture).
        const rerun = await runPersonBgAnnualSweep(new Date());
        expect(rerun.opened).toBe(0);
        expect(await personBgCountFor(adult.id)).toBe(1);
    });

    it('Trigger A opens nothing for a person attached only to a program that ended before the lookback', async () => {
        const hh = await makeHousehold('staleProg');
        const adult = await makePerson('stale-adult', hh.id, { dateOfBirth: ADULT_DOB });
        await attachToStaleProgram('stale', adult.id);

        await runPersonBgAnnualSweep(new Date());
        expect(await personBgCountFor(adult.id)).toBe(0);
    });

    it('Trigger A opens nothing when bgRecheckMonths <= 0 (policy unset)', async () => {
        const hh = await makeHousehold('nopolicy');
        const adult = await makePerson('nopolicy-adult', hh.id, { dateOfBirth: ADULT_DOB });
        await attachToProgram('nopolicy', adult.id);

        await setRecheckMonths(0);
        const res = await runPersonBgAnnualSweep(new Date());
        expect(res.opened).toBe(0);
        expect(await personBgCountFor(adult.id)).toBe(0);
        await setRecheckMonths(RECHECK_MONTHS); // restore for later tests
    });

    it('Trigger C opens on new-member activation for an already-18 joiner; an existing member taking a role mid-year opens nothing', async () => {
        // New member: household activates (INITIAL, bg already cleared, now paying) with
        // a program-attached adult member → Trigger C opens a PERSON_BG for that adult.
        const hh = await makeHousehold('joinerHh');
        const lead = await makePerson('joiner-lead', hh.id, { dateOfBirth: ADULT_DOB });
        await prisma.person.update({ where: { id: lead.id }, data: { isHouseholdLead: true } });
        const joiner = await makePerson('joiner-adult', hh.id, { dateOfBirth: ADULT_DOB });
        await attachToProgram('joiner', joiner.id);
        const membership = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
        const proc = await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: membership.id, kind: 'INITIAL', status: 'PENDING_PAYMENT', bgClearedAt: new Date() },
        });

        await activate(proc.id, { via: 'manual', actorId: lead.id });

        expect((await prisma.orgMembership.findUnique({ where: { id: membership.id } }))?.status).toBe('ACTIVE');
        expect(await personBgCountFor(joiner.id)).toBe(1); // Trigger C fired for the program adult

        // Negative: an EXISTING program member who turned 18 after the boundary. There is
        // no role-assignment trigger, and the annual run judges age as-of the boundary —
        // so nothing opens until the next annual run.
        const existingHh = await makeHousehold('existingHh');
        const roleTaker = await makePerson('role-taker', existingHh.id, { dateOfBirth: NOT_YET_18_DOB });
        await attachToProgram('role-taker', roleTaker.id);
        await runPersonBgAnnualSweep(new Date());
        expect(await personBgCountFor(roleTaker.id)).toBe(0);
    });

    it('clearBackgroundCheck stamps ONLY the subject person — a household-mate is untouched', async () => {
        const hh = await makeHousehold('subjectHh');
        const subject = await makePerson('subject', hh.id, { dateOfBirth: ADULT_DOB });
        // A household-mate (also a lead) with no check — the old blanket-stamp would have
        // hit them; the subject-scoped clear must NOT.
        const mate = await makePerson('mate', hh.id, { dateOfBirth: ADULT_DOB });
        await prisma.person.update({ where: { id: mate.id }, data: { isHouseholdLead: true } });
        // The subject's household has NO OrgMembership (a program lead in a non-member
        // household) — the gate must still work off the subject's household.
        const proc = await prisma.orgMembershipProcess.create({
            data: { kind: 'PERSON_BG', subjectPersonId: subject.id, orgMembershipId: null, status: 'PENDING_BG_REVIEW' },
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
            data: { kind: 'PERSON_BG', subjectPersonId: subject.id, orgMembershipId: null, status: 'PENDING_BG_REVIEW' },
        });
        await expect(attest(insider.id, proc.id, { result: 'APPROVE' })).rejects.toMatchObject({
            code: 'same_household_applicant',
        } as Partial<ReviewError>);
    });

    it('PERSON_BG is non-actionable in the reviewer queue (excluded from the listing) though attest() still gates it', async () => {
        // Subject in a household distinct from the reviewers → would otherwise be eligible.
        const subjHh = await makeHousehold('queueSubjHh');
        const subject = await makePerson('queue-subject', subjHh.id, { dateOfBirth: ADULT_DOB });
        const personBg = await prisma.orgMembershipProcess.create({
            data: { kind: 'PERSON_BG', subjectPersonId: subject.id, orgMembershipId: null, status: 'PENDING_BG_REVIEW' },
        });
        // Control: a household INITIAL at the same review status DOES surface.
        const appHh = await makeHousehold('queueAppHh');
        const appLead = await makePerson('queue-app-lead', appHh.id);
        await prisma.person.update({ where: { id: appLead.id }, data: { isHouseholdLead: true } });
        const appMembership = await prisma.orgMembership.create({ data: { householdId: appHh.id, status: 'NONE' } });
        const household = await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: appMembership.id, kind: 'INITIAL', status: 'PENDING_BG_REVIEW' },
        });

        const ids = await eligibleReviewProcessIds(rev1);
        expect(ids).not.toContain(personBg.id); // never offered as an actionable queue row
        expect(ids).toContain(household.id); // household review is unaffected
    });

    /** A household lead — a signing adult, whether or not they join a program. */
    async function makeLead(slug: string, householdId: number, data: Parameters<typeof makePerson>[2] = {}) {
        const p = await makePerson(slug, householdId, data);
        await prisma.person.update({ where: { id: p.id }, data: { isHouseholdLead: true } });
        return p;
    }

    it('Trigger C covers the signing adult the household clearance did not name', async () => {
        const hh = await makeHousehold('secondLeadHh');
        // Clearance names one adult and stamps only them; the other signing adult holds
        // no check and is attached to no program, so program attachment cannot find them.
        const named = await makeLead('secondlead-named', hh.id, { dateOfBirth: ADULT_DOB, lastBackgroundCheck: new Date() });
        const unnamed = await makeLead('secondlead-unnamed', hh.id, { dateOfBirth: ADULT_DOB });
        const membership = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
        const proc = await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: membership.id, kind: 'INITIAL', status: 'PENDING_PAYMENT', bgClearedAt: new Date() },
        });

        await activate(proc.id, { via: 'manual', actorId: named.id });

        expect(await personBgCountFor(unnamed.id)).toBe(1);
        expect(await personBgCountFor(named.id)).toBe(0); // already fresh
    });

    it('Trigger A covers a member household lead with no program attachment', async () => {
        const hh = await makeHousehold('sweepLeadHh');
        await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'ACTIVE' } });
        const lead = await makeLead('sweep-lead', hh.id, { dateOfBirth: ADULT_DOB });
        // Not a lead and in no program: an adult child the household never put forward.
        const bystander = await makePerson('sweep-bystander', hh.id, { dateOfBirth: ADULT_DOB });

        await runPersonBgAnnualSweep(new Date());
        expect(await personBgCountFor(lead.id)).toBe(1);
        expect(await personBgCountFor(bystander.id)).toBe(0);
    });

    it('Trigger A leaves alone the leads of households that never became members', async () => {
        // isHouseholdLead marks the lead of EVERY household the app creates. A bare lead
        // arm on the daily cron would open a PERSON_BG — closable only by a board member
        // recording an external check and two reviewers attesting — on people who never
        // applied. startIntake anchors an abandoned application's membership at NONE; a
        // denial writes DENIED; an import-only or program-only household has none at all.
        const abandoned = await makeHousehold('sweepAbandonedHh');
        await prisma.orgMembership.create({ data: { householdId: abandoned.id, status: 'NONE' } });
        const abandonedLead = await makeLead('sweep-abandoned-lead', abandoned.id, { dateOfBirth: ADULT_DOB });

        const denied = await makeHousehold('sweepDeniedHh');
        await prisma.orgMembership.create({ data: { householdId: denied.id, status: 'DENIED' } });
        const deniedLead = await makeLead('sweep-denied-lead', denied.id, { dateOfBirth: ADULT_DOB });

        const revoked = await makeHousehold('sweepRevokedHh');
        await prisma.orgMembership.create({ data: { householdId: revoked.id, status: 'REVOKED' } });
        const revokedLead = await makeLead('sweep-revoked-lead', revoked.id, { dateOfBirth: ADULT_DOB });

        const noMembership = await makeHousehold('sweepNoMembershipHh');
        const strangerLead = await makeLead('sweep-stranger-lead', noMembership.id, { dateOfBirth: ADULT_DOB });

        await runPersonBgAnnualSweep(new Date());
        expect(await personBgCountFor(abandonedLead.id)).toBe(0);
        expect(await personBgCountFor(deniedLead.id)).toBe(0);
        expect(await personBgCountFor(revokedLead.id)).toBe(0);
        expect(await personBgCountFor(strangerLead.id)).toBe(0);
    });

    it('gate: a REJECT moves the PERSON_BG to BLOCKED', async () => {
        const hh = await makeHousehold('rejectHh');
        const subject = await makePerson('reject-subject', hh.id, { dateOfBirth: ADULT_DOB });
        const proc = await prisma.orgMembershipProcess.create({
            data: { kind: 'PERSON_BG', subjectPersonId: subject.id, orgMembershipId: null, status: 'PENDING_BG_REVIEW' },
        });
        await attest(rev1, proc.id, { result: 'REJECT' });
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: proc.id } }))?.status).toBe('BLOCKED');
    });
});
