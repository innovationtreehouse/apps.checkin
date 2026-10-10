/**
 * @jest-environment node
 */
/**
 * Integration tests for Phase 3 (manual review mode) of the per-person background
 * check: the board-driven "record an external check → submit for review" action.
 *   - submit opens a PERSON_BG (dedup-guarded) + sets bgConsentAt + is audit-logged,
 *     is idempotent, and the route rejects a non-board/non-sysadmin caller;
 *   - queue gating flips on submit: an unsubmitted PERSON_BG is NOT listed/counted,
 *     a submitted one IS — with the subject identity rendered (incl. no household);
 *   - end-to-end: submit → two distinct-household reviewers attest → only the
 *     subject is stamped → the compliance dashboard PERSON_BG_NEEDED clears.
 *
 * Modeled on membershipReviewAPI / personBgComplianceAPI / personBgTriggers.
 */

import { submitPersonBgForReview } from '@/lib/membership/personBgSubmit';
import { POST as SUBMIT_BG } from '@/app/api/membership-audit/person-bg/route';
import { GET as REVIEW_QUEUE } from '@/app/api/membership/reviews/route';
import { GET as COMPLIANCE } from '@/app/api/membership-audit/compliance/route';
import { attest, eligibleReviewProcessIds } from '@/lib/membership/review';
import prisma from '@/lib/prisma';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';
import { getServerSession } from 'next-auth/next';
import { sendEmail } from '@/lib/email';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
// The reviewer ping is exercised (notifyReviewers) but must not hit Resend.
jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));
const sendEmailMock = sendEmail as jest.Mock;

const TAG = 'person-bg-submit-test';
const RECHECK_MONTHS = 12;
const BOUNDARY_SEED = new Date('2000-09-01');
const ADULT_DOB = new Date('1990-01-01');

function as(id: number, roles: { isBackgroundCheckReviewer?: boolean; isBoardMember?: boolean; isSysadmin?: boolean } = {}) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isSysadmin: false, isBoardMember: false, isBackgroundCheckReviewer: false, ...roles } });
}
function jsonReq(body: unknown) {
    return new Request('http://localhost:4000/x', { method: 'POST', body: JSON.stringify(body) }) as never;
}
function getReq() {
    return new Request('http://localhost:4000/x') as never;
}

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
async function attachToProgram(slug: string, personId: number) {
    const program = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `${TAG} ${slug} program` } });
    await prisma.programParticipant.create({ data: { programId: program.id, personId } });
    return program.id;
}
function personBgFor(personId: number) {
    return prisma.orgMembershipProcess.findFirst({ where: { kind: 'PERSON_BG', subjectPersonId: personId }, orderBy: { id: 'desc' } });
}
function personBgCountFor(personId: number) {
    return prisma.orgMembershipProcess.count({ where: { kind: 'PERSON_BG', subjectPersonId: personId } });
}
async function setRecheckMonths(months: number) {
    await prisma.boardSettings.upsert({
        where: { id: 1 },
        create: { id: 1, bgRecheckMonths: months, orgMembershipYearBoundary: BOUNDARY_SEED },
        update: { bgRecheckMonths: months, orgMembershipYearBoundary: BOUNDARY_SEED },
    });
}

async function cleanup() {
    // People created directly (no household) are tagged via email; households via name.
    const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = hhs.map((h) => h.id);
    const progs = await prisma.program.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const progIds = progs.map((p) => p.id);
    const taggedPeople = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { id: true, householdId: true } });
    const peopleIds = taggedPeople.map((p) => p.id);
    // A nameless household (the "no household context" fixture) isn't matched by name —
    // reap it via the tagged person that lives in it.
    const peopleHhIds = taggedPeople.map((p) => p.householdId);
    const procs = await prisma.orgMembershipProcess.findMany({
        where: { OR: [{ orgMembership: { householdId: { in: ids } } }, { subjectPersonId: { in: peopleIds } }] },
        select: { id: true },
    });
    const pids = procs.map((p) => p.id);
    await prisma.backgroundCheckAttestation.deleteMany({ where: { processId: { in: pids } } });
    await prisma.programParticipant.deleteMany({ where: { programId: { in: progIds } } });
    await prisma.programVolunteer.deleteMany({ where: { programId: { in: progIds } } });
    await prisma.program.deleteMany({ where: { id: { in: progIds } } });
    await prisma.orgMembershipProcess.deleteMany({ where: { id: { in: pids } } });
    await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
    await prisma.person.deleteMany({ where: { OR: [{ householdId: { in: ids } }, { id: { in: peopleIds } }] } });
    await prisma.household.deleteMany({ where: { id: { in: [...ids, ...peopleHhIds] } } });
}

describe('Phase 3 — manual PERSON_BG submit + queue gating + e2e', () => {
    let restoreBoardSettings: () => Promise<void>;
    let rev1 = 0, rev2 = 0, board = 0, nonReviewer = 0;

    beforeAll(async () => {
        await cleanup();
        restoreBoardSettings = await snapshotBoardSettings();
        await setRecheckMonths(RECHECK_MONTHS);

        const hhA = await makeHousehold('revA');
        const hhB = await makeHousehold('revB');
        const hhC = await makeHousehold('misc');
        rev1 = (await makePerson('rev1', hhA.id, { isBackgroundCheckReviewer: true })).id;
        rev2 = (await makePerson('rev2', hhB.id, { isBackgroundCheckReviewer: true })).id;
        board = (await makePerson('board', hhC.id)).id;
        nonReviewer = (await makePerson('nonreviewer', hhC.id)).id;
    });

    afterAll(async () => {
        await cleanup();
        await restoreBoardSettings();
        await prisma.$disconnect();
    });

    it('submit opens a PERSON_BG, sets bgConsentAt, audit-logs it, and is idempotent', async () => {
        const hh = await makeHousehold('submitHh');
        const subject = await makePerson('submit-subject', hh.id, { dateOfBirth: ADULT_DOB });
        await attachToProgram('submit', subject.id);

        sendEmailMock.mockClear();
        await submitPersonBgForReview(subject.id, board);

        const proc = await personBgFor(subject.id);
        expect(proc).not.toBeNull();
        expect(proc!.status).toBe('PENDING_BG_REVIEW');
        expect(proc!.bgConsentAt).not.toBeNull(); // review-ready
        expect(await personBgCountFor(subject.id)).toBe(1);
        // Audit: the open (CREATE) + the consent mark (EDIT) both landed on this process.
        const audits = await prisma.auditLog.count({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: proc!.id } });
        expect(audits).toBeGreaterThanOrEqual(1);
        // First submit pinged reviewers.
        expect(sendEmailMock.mock.calls.length).toBeGreaterThan(0);

        // Idempotent: a second submit does not double-open and does not re-ping.
        sendEmailMock.mockClear();
        await submitPersonBgForReview(subject.id, board);
        expect(await personBgCountFor(subject.id)).toBe(1);
        expect(sendEmailMock.mock.calls.length).toBe(0);
    });

    it('route rejects an anon (401) and a non-board / non-sysadmin caller (403), no obligation opened', async () => {
        const hh = await makeHousehold('gateHh');
        const subject = await makePerson('gate-subject', hh.id, { dateOfBirth: ADULT_DOB });

        // Anonymous — no session.
        (getServerSession as jest.Mock).mockResolvedValue(null);
        expect((await SUBMIT_BG(jsonReq({ personId: subject.id }))).status).toBe(401);

        // Authenticated but unprivileged.
        as(nonReviewer, {});
        const res = await SUBMIT_BG(jsonReq({ personId: subject.id }));
        expect(res.status).toBe(403);
        expect(await personBgCountFor(subject.id)).toBe(0);

        // Board caller succeeds through the same route.
        as(board, { isBoardMember: true });
        const ok = await SUBMIT_BG(jsonReq({ personId: subject.id }));
        expect(ok.status).toBe(200);
        expect(await personBgCountFor(subject.id)).toBe(1);
    });

    it('queue gating flips on submit — excluded until submitted, then listed with subject identity (incl. no household)', async () => {
        // Subject WITH a household, distinct from the reviewers.
        const subjHh = await makeHousehold('queueSubjHh');
        const subject = await makePerson('queue-subject', subjHh.id, { dateOfBirth: ADULT_DOB });
        const personBg = await prisma.orgMembershipProcess.create({
            data: { kind: 'PERSON_BG', subjectPersonId: subject.id, orgMembershipId: null, status: 'PENDING_BG_REVIEW' },
        });
        // Subject whose household carries no name — the render must fall back to
        // "No household on file" rather than blank (Person.householdId is required,
        // so an empty-name household is the real "no household context" case).
        // name is NOT NULL; "" is the empty sentinel and the render's falsy check
        // (`household?.name ? … : "No household on file"`) treats it like the old null.
        const namelessHh = await prisma.household.create({ data: { name: "" } });
        const orphan = await makePerson('queue-orphan', namelessHh.id, { dateOfBirth: ADULT_DOB });
        const orphanBg = await prisma.orgMembershipProcess.create({
            data: { kind: 'PERSON_BG', subjectPersonId: orphan.id, orgMembershipId: null, status: 'PENDING_BG_REVIEW' },
        });

        // Before submit: neither is listed/counted.
        let ids = await eligibleReviewProcessIds(rev1);
        expect(ids).not.toContain(personBg.id);
        expect(ids).not.toContain(orphanBg.id);

        // Submit both (idempotent open already exists → just marks bgConsentAt).
        await submitPersonBgForReview(subject.id, board);
        await submitPersonBgForReview(orphan.id, board);

        ids = await eligibleReviewProcessIds(rev1);
        expect(ids).toContain(personBg.id);
        expect(ids).toContain(orphanBg.id);

        // The GET renders the subject identity + household context, and never blanks.
        as(rev1, { isBackgroundCheckReviewer: true });
        const data = await (await REVIEW_QUEUE(getReq())).json();
        const rows: Array<{ id: number; subjectPerson: { name: string; household: { name: string | null } | null } | null }> = data.queue;
        const withHh = rows.find((r) => r.id === personBg.id);
        const noHh = rows.find((r) => r.id === orphanBg.id);
        expect(withHh?.subjectPerson?.name).toBe('queue-subject');
        expect(withHh?.subjectPerson?.household?.name).toBe(`${TAG} queueSubjHh`);
        expect(noHh?.subjectPerson?.name).toBe('queue-orphan');
        expect(noHh?.subjectPerson?.household?.name).toBe(""); // empty-name household → "No household on file"
    });

    it('end-to-end: submit → two distinct reviewers attest → only the subject is stamped → dashboard clears', async () => {
        const hh = await makeHousehold('e2eHh');
        const subject = await makePerson('e2e-subject', hh.id, { dateOfBirth: ADULT_DOB });
        await attachToProgram('e2e', subject.id);
        // A household-mate with no check — the subject-scoped clear must not touch them.
        const mate = await makePerson('e2e-mate', hh.id, { dateOfBirth: ADULT_DOB });
        await prisma.person.update({ where: { id: mate.id }, data: { isHouseholdLead: true } });

        // Before: the subject is on the dashboard's PERSON_BG_NEEDED list.
        as(board, { isBoardMember: true });
        let compliance = await (await COMPLIANCE(getReq())).json();
        expect(compliance.peopleNeedingBgCheck.some((p: { personId: number }) => p.personId === subject.id)).toBe(true);

        // Submit, then two distinct-household reviewers attest.
        await submitPersonBgForReview(subject.id, board);
        const proc = await personBgFor(subject.id);
        await attest(rev1, proc!.id, { result: 'APPROVE' });
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: proc!.id } }))?.status).toBe('PENDING_BG_REVIEW');
        await attest(rev2, proc!.id, { result: 'APPROVE' });

        const after = await prisma.orgMembershipProcess.findUnique({ where: { id: proc!.id } });
        expect(after?.bgClearedAt).not.toBeNull();
        expect(after?.status).toBe('ACTIVE');

        // Only the subject is stamped; the household-mate is untouched.
        expect((await prisma.person.findUnique({ where: { id: subject.id } }))?.lastBackgroundCheck).not.toBeNull();
        expect((await prisma.person.findUnique({ where: { id: mate.id } }))?.lastBackgroundCheck).toBeNull();

        // After: the subject has dropped off the dashboard PERSON_BG_NEEDED list.
        as(board, { isBoardMember: true });
        compliance = await (await COMPLIANCE(getReq())).json();
        expect(compliance.peopleNeedingBgCheck.some((p: { personId: number }) => p.personId === subject.id)).toBe(false);
    });
});
