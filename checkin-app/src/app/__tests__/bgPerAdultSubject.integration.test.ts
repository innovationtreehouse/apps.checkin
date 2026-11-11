/**
 * @jest-environment node
 */
/**
 * Per-adult background-check subjects. A check review a household's consent opened
 * names one lead at its first decision, and clearing it stamps only that person, so
 * an adult who was never checked does not read as cleared and stays visible to the
 * machinery meant to catch them. Every case here needs a TWO-lead household; a
 * single-lead one cannot show the difference.
 */

import { POST as ATTEST } from '@/app/api/membership/reviews/route';
import { POST as OVERRIDE } from '@/app/api/membership-ops/applications/review-override/route';
import { GET as COMPLIANCE } from '@/app/api/membership-audit/compliance/route';
import { eligibleReviewProcessIds } from '@/lib/membership/review';
import { bgFreshThreshold, personBgVerdict } from '@/lib/membership/personBgCheck';
import { householdCheckStandings, householdQualifies } from '@/lib/membership/checkStanding';
import prisma from '@/lib/prisma';
import { setBgRecheckPolicy } from '@/test-helpers/boardSettings';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/email', () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));

const TAG = 'bg-subject-test';

function as(id: number, roles: { isBackgroundCheckReviewer?: boolean; isBoardMember?: boolean; isSysadmin?: boolean } = {}) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isSysadmin: false, isBoardMember: false, isBackgroundCheckReviewer: false, ...roles } });
}
function req(body: unknown, url = 'http://localhost:4000/x') {
    return new Request(url, { method: 'POST', body: JSON.stringify(body) }) as unknown as Parameters<typeof ATTEST>[0];
}
function get(url: string) {
    return new Request(url) as unknown as Parameters<typeof COMPLIANCE>[0];
}

describe('Per-adult background-check subjects', () => {
    let rev1: number, rev2: number, board: number;
    let restorePolicy: () => Promise<void> = async () => {};

    /**
     * A household with TWO adult leads at payment with consent recorded (`appId`), and
     * the check review its consent opened (`processId`), naming nobody yet.
     */
    async function twoLeadHousehold(label: string) {
        const hh = await prisma.household.create({ data: { name: `${label} ${TAG}` } });
        const mkLead = async (name: string) => {
            const p = await prisma.person.create({ data: { name: `${name} ${label}`, email: `${name}-${label}-${TAG}@example.com`, householdId: hh.id, isDeclaredAdult: true } });
            await prisma.person.update({ where: { id: p.id }, data: { isHouseholdLead: true } });
            return p.id;
        };
        const alex = await mkLead('Alex');
        const sam = await mkLead('Sam');
        const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
        const now = new Date();
        const app = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.id, kind: 'INITIAL', status: 'PENDING_PAYMENT', contractSignedAt: now, bgConsentAt: now } });
        const review = await prisma.orgMembershipProcess.create({ data: { kind: 'PERSON_BG', requestedForHouseholdId: hh.id, status: 'PENDING_BG_REVIEW', bgConsentAt: now } });
        return { householdId: hh.id, orgMembershipId: m.id, appId: app.id, processId: review.id, alex, sam };
    }

    const bgDate = (id: number) => prisma.person.findUnique({ where: { id }, select: { lastBackgroundCheck: true } }).then((p) => p?.lastBackgroundCheck ?? null);

    async function wipe() {
        const hhs = await prisma.household.findMany({ where: { OR: [{ name: { contains: TAG } }, { householdMembers: { some: { email: { contains: TAG } } } }] }, select: { id: true } });
        const ids = hhs.map((h) => h.id);
        if (ids.length) {
            // PersonMerge.toId is RESTRICT — the archive outranks its survivor, so it
            // has to go before the Person rows below.
            await prisma.personMerge.deleteMany({ where: { to: { householdId: { in: ids } } } });
            const processes = { OR: [{ orgMembership: { householdId: { in: ids } } }, { requestedForHouseholdId: { in: ids } }] };
            await prisma.backgroundCheckAttestation.deleteMany({ where: { process: processes } });
            await prisma.programVolunteer.deleteMany({ where: { person: { householdId: { in: ids } } } });
            await prisma.orgMembershipProcess.deleteMany({ where: processes });
            await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.household.deleteMany({ where: { id: { in: ids } } });
        }
        await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
    }

    beforeAll(async () => {
        await wipe();
        restorePolicy = await setBgRecheckPolicy();
        const mk = async (slug: string, role: object) =>
            prisma.person.create({ data: { email: `${slug}-${TAG}@example.com`, name: slug, household: { create: { name: `${slug} HH ${TAG}` } }, ...role } });
        rev1 = (await mk('sub-rev1', { isBackgroundCheckReviewer: true })).id;
        rev2 = (await mk('sub-rev2', { isBackgroundCheckReviewer: true })).id;
        board = (await mk('sub-board', { isBoardMember: true })).id;
    });

    afterAll(async () => {
        await wipe();
        await restorePolicy();
        await prisma.$disconnect();
    });

    // ── Only the named adult is stamped ──────────────────────────────────────
    it('stamps only the adult both reviewers named — the household-mate stays unchecked', async () => {
        const hh = await twoLeadHousehold('Regression');

        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);
        as(rev2, { isBackgroundCheckReviewer: true });
        const res = await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);
        expect((await res.json()).outcome.status).toBe('ACTIVE');

        expect(await bgDate(hh.alex)).not.toBeNull();
        // This is the assertion that would have caught the report.
        expect(await bgDate(hh.sam)).toBeNull();
    });

    it('membership is unaffected — one checked adult still satisfies the household', async () => {
        const hh = await twoLeadHousehold('MembershipUnchanged');
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);
        as(rev2, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);

        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: hh.appId } });
        expect(proc?.bgClearedAt).not.toBeNull();
        expect(proc?.status).toBe('PENDING_PAYMENT');
        // The household qualifies on ANY lead cleared, which rule 1 requires — per-adult stamping
        // must not tighten the membership gate to "every lead".
        const threshold = bgFreshThreshold(new Date(Date.now() + 86_400_000), 12);
        expect(householdQualifies(await householdCheckStandings(prisma, hh.householdId, threshold))).toBe(true);
    });

    it('the unnamed adult reads as NEEDED, not FRESH', async () => {
        const hh = await twoLeadHousehold('NagOn');
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);
        as(rev2, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);

        const boundary = new Date(Date.now() + 86_400_000);
        const threshold = bgFreshThreshold(boundary, 12);
        const [alex, sam] = await prisma.person.findMany({ where: { id: { in: [hh.alex, hh.sam] } }, orderBy: { id: 'asc' }, select: { dateOfBirth: true, isDeclaredAdult: true, lastBackgroundCheck: true } });
        expect(personBgVerdict(alex, boundary, threshold)).toBe('FRESH');
        // Reading NEEDED is what keeps Sam in peopleNeedingBgCheck and in every PERSON_BG
        // trigger.
        expect(personBgVerdict(sam, boundary, threshold)).toBe('NEEDED');
    });

    it('a review names one adult — naming two at once is refused', async () => {
        const hh = await twoLeadHousehold('OneOnly');
        as(rev1, { isBackgroundCheckReviewer: true });
        const res = await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex, hh.sam] }) as never);
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('invalid_subject');
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId: hh.processId } })).toBe(0);
    });

    // ── The first decision settles who the review is about ───────────────────
    it('the second reviewer cannot switch the review to a different adult', async () => {
        const hh = await twoLeadHousehold('SubjectSettled');
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);

        // A review is about one person; a reviewer who thinks it is the wrong one asks
        // the Board for the wrong-person reset.
        as(rev2, { isBackgroundCheckReviewer: true });
        const wrong = await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.sam] }) as never);
        expect(wrong.status).toBe(400);
        expect((await wrong.json()).code).toBe('invalid_subject');

        // Confirming the settled subject clears it on the second approval.
        const right = await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);
        expect((await right.json()).outcome.status).toBe('ACTIVE');
        expect(await bgDate(hh.alex)).not.toBeNull();
        expect(await bgDate(hh.sam)).toBeNull();
    });

    it('a named person who stops being a lead still clears as a person, and no longer clears the household', async () => {
        const hh = await twoLeadHousehold('SubjectLeft');
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);

        await prisma.person.update({ where: { id: hh.alex }, data: { isHouseholdLead: false } });

        as(rev2, { isBackgroundCheckReviewer: true });
        const res = await ATTEST(req({ processId: hh.processId, result: 'APPROVE' }) as never);
        expect(res.status).toBe(200);
        expect(await bgDate(hh.alex)).not.toBeNull();
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: hh.appId } }))?.bgClearedAt).toBeNull();
    });

    it('a rejection after the first approval records the named person', async () => {
        const hh = await twoLeadHousehold('SubjectDispute');
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);

        as(rev2, { isBackgroundCheckReviewer: true });
        const res = await ATTEST(req({ processId: hh.processId, result: 'REJECT', note: 'Concerning record' }) as never);
        expect((await res.json()).outcome.status).toBe('BLOCKED');
        const rejection = await prisma.backgroundCheckAttestation.findFirstOrThrow({ where: { processId: hh.processId, result: 'REJECT' } });
        expect(rejection.subjectPersonId).toBe(hh.alex);
        expect(await bgDate(hh.alex)).toBeNull();
        expect(await bgDate(hh.sam)).toBeNull();
    });

    // ── Naming is mandatory ──────────────────────────────────────────────────
    it('a first decision naming nobody is a 400, approve or reject, and writes nothing', async () => {
        const hh = await twoLeadHousehold('NoSubject');
        as(rev1, { isBackgroundCheckReviewer: true });

        for (const body of [{ result: 'APPROVE' }, { result: 'APPROVE', subjectPersonIds: [] }, { result: 'APPROVE', subjectPersonIds: 'nope' }, { result: 'REJECT', note: 'concerning' }]) {
            const res = await ATTEST(req({ processId: hh.processId, ...body }) as never);
            expect(res.status).toBe(400);
            expect((await res.json()).code).toBe('invalid_subject');
        }
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId: hh.processId } })).toBe(0);
    });

    it('naming someone who is not a lead of this household is a 400', async () => {
        const hh = await twoLeadHousehold('WrongSubject');
        as(rev1, { isBackgroundCheckReviewer: true });
        const res = await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [rev2] }) as never);
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('invalid_subject');
    });

    it('a first rejection names its person', async () => {
        const hh = await twoLeadHousehold('RejectNamed');
        as(rev1, { isBackgroundCheckReviewer: true });
        const res = await ATTEST(req({ processId: hh.processId, result: 'REJECT', note: 'Concerning record', subjectPersonIds: [hh.sam] }) as never);
        expect((await res.json()).outcome.status).toBe('BLOCKED');
        const rows = await prisma.backgroundCheckAttestation.findMany({ where: { processId: hh.processId } });
        expect(rows).toHaveLength(1);
        expect(rows[0].subjectPersonId).toBe(hh.sam);
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: hh.processId } }))?.subjectPersonId).toBe(hh.sam);
    });

    // ── One attestation per reviewer settles their part ──────────────────────
    it('a reviewer drops out of the queue once they have attested', async () => {
        const hh = await twoLeadHousehold('OnceOnly');
        as(rev1, { isBackgroundCheckReviewer: true });
        expect(await eligibleReviewProcessIds(rev1)).toContain(hh.processId);
        await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);

        expect(await eligibleReviewProcessIds(rev1)).not.toContain(hh.processId);
        const dup = await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);
        expect(dup.status).toBe(409);
        expect((await dup.json()).code).toBe('already_attested');
    });

    // ── Approvals recorded on the household application are history ─────────
    it("approvals on the household application count for nothing; the check review needs two of its own", async () => {
        const hh = await twoLeadHousehold('Legacy');
        await prisma.backgroundCheckAttestation.create({ data: { processId: hh.appId, reviewerId: rev1, result: 'APPROVE', subjectPersonId: hh.alex } });
        await prisma.backgroundCheckAttestation.create({ data: { processId: hh.appId, reviewerId: board, result: 'APPROVE', subjectPersonId: hh.alex } });

        as(rev2, { isBackgroundCheckReviewer: true });
        const res = await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);
        expect((await res.json()).outcome.approvals).toBe(1);
        expect(await bgDate(hh.alex)).toBeNull();
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: hh.appId } }))?.bgClearedAt).toBeNull();
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId: hh.appId } })).toBe(2);
    });

    // ── A blocked review: no board clearance (Board ruling B5/B25) ────────────
    it('the board cannot clear a blocked review: the override approve is gone (400, nothing stamped)', async () => {
        const hh = await twoLeadHousehold('NoForce');
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'REJECT', note: 'Needs a second look', subjectPersonIds: [hh.alex] }) as never);

        as(board, { isBoardMember: true });
        const res = await OVERRIDE(req({ processId: hh.processId, action: 'approve', subjectPersonIds: [hh.alex] }) as never);
        expect(res.status).toBe(400);
        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: hh.processId } });
        expect(proc?.bgClearedAt).toBeNull();
        expect(proc?.status).toBe('BLOCKED');
        expect(await bgDate(hh.alex)).toBeNull();
    });

    it('the rejector changing to approve keeps the named adult, and only that adult is stamped once two new reviewers agree', async () => {
        const hh = await twoLeadHousehold('SwitchNamed');
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'REJECT', note: 'Needs a second look', subjectPersonIds: [hh.alex] }) as never);
        const other = await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.sam] }) as never);
        expect(other.status).toBe(400);
        const switched = await ATTEST(req({ processId: hh.processId, result: 'APPROVE' }) as never);
        expect((await switched.json()).outcome).toEqual({ status: 'PENDING_BG_REVIEW', approvals: 1 });

        as(rev2, { isBackgroundCheckReviewer: true });
        const second = await ATTEST(req({ processId: hh.processId, result: 'APPROVE' }) as never);
        expect(second.status).toBe(200);
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: hh.processId } }))?.bgClearedAt).not.toBeNull();
        expect(await bgDate(hh.alex)).not.toBeNull();
        expect(await bgDate(hh.sam)).toBeNull();
    });

    it('a reset needs a reason and no subjects — it deletes the attestations and re-opens review', async () => {
        const hh = await twoLeadHousehold('ForceReset');
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'REJECT', note: 'Needs a second look', subjectPersonIds: [hh.alex] }) as never);

        as(board, { isBoardMember: true });
        const res = await OVERRIDE(req({ processId: hh.processId, action: 'reset', reason: 'second look' }) as never);
        expect(res.status).toBe(200);
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId: hh.processId } })).toBe(0);
    });

    // ── Remediation worklist ─────────────────────────────────────────────────
    describe('blanket-stamp worklist', () => {
        const CLEARED_AT = new Date('2026-07-15T12:00:00.000Z');

        /** A household carrying a blanket stamp: every lead stamped with the
         *  process's own bgClearedAt, to the millisecond. */
        async function blanketStamped(label: string, opts: { consentBy?: 'lead' | 'board'; namedAttestation?: boolean } = {}) {
            const hh = await twoLeadHousehold(label);
            await prisma.person.updateMany({ where: { id: { in: [hh.alex, hh.sam] } }, data: { lastBackgroundCheck: CLEARED_AT } });
            await prisma.orgMembershipProcess.update({ where: { id: hh.appId }, data: { bgClearedAt: CLEARED_AT, status: 'PENDING_PAYMENT' } });
            if (opts.namedAttestation) {
                await prisma.backgroundCheckAttestation.create({ data: { processId: hh.appId, reviewerId: rev1, result: 'APPROVE', subjectPersonId: hh.alex } });
            }
            if (opts.consentBy) {
                await prisma.auditLog.create({
                    data: { actorId: opts.consentBy === 'lead' ? hh.alex : board, action: 'EDIT', tableName: 'OrgMembershipProcess', affectedEntityId: hh.appId, newData: { bgConsentAt: true } },
                });
            }
            return { ...hh, processId: hh.appId };
        }

        it('lists a blanket-stamped household and labels the likely subject', async () => {
            const hh = await blanketStamped('SelfConsent', { consentBy: 'lead' });
            as(board, { isBoardMember: true });
            const data = await (await COMPLIANCE(get('http://localhost:4000/api/membership-audit/compliance') as never)).json();

            const row = data.blanketStamped.find((r: { processId: number }) => r.processId === hh.processId);
            expect(row).toBeDefined();
            expect(row.leads).toHaveLength(2);
            expect(row.leads.find((l: { personId: number }) => l.personId === hh.alex).likelySubject).toBe(true);
            expect(row.leads.find((l: { personId: number }) => l.personId === hh.sam).likelySubject).toBe(false);
        });

        it('labels a board-recorded consent as telling us nothing about who was checked', async () => {
            const hh = await blanketStamped('BoardConsent', { consentBy: 'board' });
            as(board, { isBoardMember: true });
            const data = await (await COMPLIANCE(get('http://localhost:4000/api/membership-audit/compliance') as never)).json();

            const row = data.blanketStamped.find((r: { processId: number }) => r.processId === hh.processId);
            expect(row.consentRecorded).toBe(true);
            expect(row.leads.every((l: { likelySubject: boolean }) => !l.likelySubject)).toBe(true);
        });

        it('skips a single-lead household, a fresh-check shortcut, and a per-adult clearance', async () => {
            // Single lead: only ever one stamp, so nothing to disambiguate.
            const single = await twoLeadHousehold('SingleLead');
            await prisma.person.update({ where: { id: single.sam }, data: { isHouseholdLead: false } });
            await prisma.person.update({ where: { id: single.alex }, data: { lastBackgroundCheck: CLEARED_AT } });
            await prisma.orgMembershipProcess.update({ where: { id: single.appId }, data: { bgClearedAt: CLEARED_AT } });

            // Fresh-check shortcut: bgClearedAt set, no Person ever stamped.
            const shortcut = await twoLeadHousehold('Shortcut');
            await prisma.orgMembershipProcess.update({ where: { id: shortcut.appId }, data: { bgClearedAt: CLEARED_AT } });

            // Cleared under per-adult rules: both named, both stamped — correct data.
            const named = await blanketStamped('PerAdult', { namedAttestation: true });

            as(board, { isBoardMember: true });
            const data = await (await COMPLIANCE(get('http://localhost:4000/api/membership-audit/compliance') as never)).json();
            const ids = data.blanketStamped.map((r: { processId: number }) => r.processId);
            expect(ids).not.toContain(single.appId);
            expect(ids).not.toContain(shortcut.appId);
            expect(ids).not.toContain(named.processId);
        });

        it('narrows to the cleared-since cutoff', async () => {
            const hh = await blanketStamped('Cutoff');
            as(board, { isBoardMember: true });

            const inRange = await (await COMPLIANCE(get('http://localhost:4000/api/membership-audit/compliance?bgClearedSince=2026-07-01') as never)).json();
            expect(inRange.blanketStamped.map((r: { processId: number }) => r.processId)).toContain(hh.processId);

            const after = await (await COMPLIANCE(get('http://localhost:4000/api/membership-audit/compliance?bgClearedSince=2026-08-01') as never)).json();
            expect(after.blanketStamped.map((r: { processId: number }) => r.processId)).not.toContain(hh.processId);
        });
    });

    // The merge rule takes the later date unconditionally, recording nothing about whose
    // check it was; the PersonMerge snapshot is the only record of the merged-away person.
    it('flags a merge-inherited background-check date and names its source', async () => {
        const hh = await twoLeadHousehold('MergeArchived');
        const checkedAt = new Date('2026-06-01T00:00:00.000Z');
        await prisma.person.update({ where: { id: hh.alex }, data: { lastBackgroundCheck: checkedAt } });
        await prisma.personMerge.create({
            data: {
                fromId: hh.sam,
                toId: hh.alex,
                snapshot: { name: 'Sam Archived', email: null, lastBackgroundCheck: checkedAt.toISOString() },
            },
        });
        await prisma.person.delete({ where: { id: hh.sam } });

        as(board, { isBoardMember: true });
        const data = await (await COMPLIANCE(get('http://localhost:4000/api/membership-audit/compliance') as never)).json();

        const row = data.mergeInheritedBgChecks.find((r: { personId: number }) => r.personId === hh.alex);
        expect(row).toBeDefined();
        expect(row.fromName).toBe('Sam Archived');
    });
});
