/**
 * @jest-environment node
 */
/**
 * Per-adult background-check subjects (#1260). The defect these lock in: clearing a
 * household check used to stamp EVERY lead, so an adult who was never checked read as
 * cleared everywhere — and that false stamp then hid them from the machinery meant to
 * catch it. Every case here needs a TWO-lead household; the pre-existing review suites
 * all use single-lead ones, which is why none of them saw the bug.
 */

import { POST as ATTEST } from '@/app/api/membership/reviews/route';
import { POST as OVERRIDE } from '@/app/api/membership-ops/applications/review-override/route';
import { GET as COMPLIANCE } from '@/app/api/membership-audit/compliance/route';
import { eligibleReviewProcessIds, boardResetReview } from '@/lib/membership/review';
import { bgFreshThreshold, personBgVerdict } from '@/lib/membership/personBgCheck';
import { householdBgIsFresh } from '@/lib/membership/renewal';
import prisma from '@/lib/prisma';
import { sendEmail } from '@/lib/email';
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

    /** A household with TWO adult leads awaiting background-check review. */
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
        const proc = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.id, kind: 'INITIAL', status: 'PENDING_BG_REVIEW' } });
        return { householdId: hh.id, orgMembershipId: m.id, processId: proc.id, alex, sam };
    }

    const bgDate = (id: number) => prisma.person.findUnique({ where: { id }, select: { lastBackgroundCheck: true } }).then((p) => p?.lastBackgroundCheck ?? null);

    async function wipe() {
        const hhs = await prisma.household.findMany({ where: { OR: [{ name: { contains: TAG } }, { householdMembers: { some: { email: { contains: TAG } } } }] }, select: { id: true } });
        const ids = hhs.map((h) => h.id);
        if (ids.length) {
            // PersonMerge.toId is RESTRICT — the archive outranks its survivor, so it
            // has to go before the Person rows below.
            await prisma.personMerge.deleteMany({ where: { to: { householdId: { in: ids } } } });
            await prisma.backgroundCheckAttestation.deleteMany({ where: { process: { orgMembership: { householdId: { in: ids } } } } });
            await prisma.programVolunteer.deleteMany({ where: { person: { householdId: { in: ids } } } });
            await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: ids } } } });
            await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.household.deleteMany({ where: { id: { in: ids } } });
        }
        await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
    }

    beforeAll(async () => {
        await wipe();
        const mk = async (slug: string, role: object) =>
            prisma.person.create({ data: { email: `${slug}-${TAG}@example.com`, name: slug, household: { create: { name: `${slug} HH ${TAG}` } }, ...role } });
        rev1 = (await mk('sub-rev1', { isBackgroundCheckReviewer: true })).id;
        rev2 = (await mk('sub-rev2', { isBackgroundCheckReviewer: true })).id;
        board = (await mk('sub-board', { isBoardMember: true })).id;
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    // ── The regression itself ────────────────────────────────────────────────
    it('stamps only the adult both reviewers named — the household-mate stays unchecked', async () => {
        const hh = await twoLeadHousehold('Regression');

        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);
        as(rev2, { isBackgroundCheckReviewer: true });
        const res = await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);
        expect((await res.json()).outcome.status).toBe('PENDING_PAYMENT');

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

        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: hh.processId } });
        expect(proc?.bgClearedAt).not.toBeNull();
        expect(proc?.status).toBe('PENDING_PAYMENT');
        // householdBgIsFresh is "ANY lead fresh", which rule 1 requires — the fix must
        // not tighten the membership gate to "every lead".
        const boundary = new Date(Date.now() + 86_400_000);
        expect(await householdBgIsFresh(hh.householdId, boundary, 12)).toBe(true);
    });

    it('the unnamed adult now reads as NEEDED instead of FRESH', async () => {
        const hh = await twoLeadHousehold('NagOn');
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);
        as(rev2, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);

        const boundary = new Date(Date.now() + 86_400_000);
        const threshold = bgFreshThreshold(boundary, 12);
        const [alex, sam] = await prisma.person.findMany({ where: { id: { in: [hh.alex, hh.sam] } }, orderBy: { id: 'asc' }, select: { dateOfBirth: true, isDeclaredAdult: true, lastBackgroundCheck: true } });
        expect(personBgVerdict(alex, boundary, threshold)).toBe('FRESH');
        // Before the fix Sam read FRESH here, which is what kept them out of
        // peopleNeedingBgCheck and out of every PERSON_BG trigger.
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

    // ── The first approval settles who the review is about ───────────────────
    it('the second reviewer cannot switch the review to a different adult', async () => {
        const hh = await twoLeadHousehold('SubjectSettled');
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);

        // Naming Sam instead would leave Alex and Sam both at one approval and the
        // review waiting on a third reviewer. Disagreement goes through REJECT.
        as(rev2, { isBackgroundCheckReviewer: true });
        const wrong = await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.sam] }) as never);
        expect(wrong.status).toBe(400);
        expect((await wrong.json()).code).toBe('invalid_subject');

        // Confirming the settled subject clears it on the second approval.
        const right = await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);
        expect((await right.json()).outcome.status).toBe('PENDING_PAYMENT');
        expect(await bgDate(hh.alex)).not.toBeNull();
        expect(await bgDate(hh.sam)).toBeNull();
    });

    it('the second approval refuses a subject who is no longer a live household lead', async () => {
        const hh = await twoLeadHousehold('SubjectLeft');
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);

        await prisma.person.update({ where: { id: hh.alex }, data: { isHouseholdLead: false } });

        as(rev2, { isBackgroundCheckReviewer: true });
        const res = await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('invalid_subject');
        expect(await bgDate(hh.alex)).toBeNull();
        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: hh.processId } });
        expect(proc?.bgClearedAt).toBeNull();
    });

    it('a reviewer who disagrees with the settled subject rejects instead', async () => {
        const hh = await twoLeadHousehold('SubjectDispute');
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);

        as(rev2, { isBackgroundCheckReviewer: true });
        const res = await ATTEST(req({ processId: hh.processId, result: 'REJECT', note: 'Report names Sam, not Alex' }) as never);
        expect((await res.json()).outcome.status).toBe('BLOCKED');
        expect(await bgDate(hh.alex)).toBeNull();
        expect(await bgDate(hh.sam)).toBeNull();
    });

    // ── Naming is mandatory ──────────────────────────────────────────────────
    it('approving without naming anyone is a 400, and writes nothing', async () => {
        const hh = await twoLeadHousehold('NoSubject');
        as(rev1, { isBackgroundCheckReviewer: true });

        for (const body of [{}, { subjectPersonIds: [] }, { subjectPersonIds: 'nope' }]) {
            const res = await ATTEST(req({ processId: hh.processId, result: 'APPROVE', ...body }) as never);
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

    it('a rejection stays whole-process and names nobody', async () => {
        const hh = await twoLeadHousehold('RejectWhole');
        as(rev1, { isBackgroundCheckReviewer: true });
        const res = await ATTEST(req({ processId: hh.processId, result: 'REJECT', note: 'Concerning record' }) as never);
        expect((await res.json()).outcome.status).toBe('BLOCKED');
        const rows = await prisma.backgroundCheckAttestation.findMany({ where: { processId: hh.processId } });
        expect(rows).toHaveLength(1);
        expect(rows[0].subjectPersonId).toBeNull();
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

    // ── An approval that names nobody ────────────────────────────────────────
    it('an approval naming nobody counts toward nobody, and reports the count it counted', async () => {
        const hh = await twoLeadHousehold('Legacy');
        // An approval whose subject column is null: what a review in flight across the
        // subject migration (20260802120000, nullable, no backfill) carries.
        await prisma.backgroundCheckAttestation.create({ data: { processId: hh.processId, reviewerId: rev1, result: 'APPROVE', subjectPersonId: null } });

        as(rev2, { isBackgroundCheckReviewer: true });
        const res = await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);
        expect(res.status).toBe(200);

        // GUARD. Alex holds one approval, not two — the subject-less row vouches for no
        // one, so nothing clears and nobody is stamped. Nothing records whose report rev1
        // read; counting it would date Alex's clearance on rev2's reading alone.
        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: hh.processId } });
        expect(proc?.bgClearedAt).toBeNull();
        expect(await bgDate(hh.alex)).toBeNull();
        expect(await bgDate(hh.sam)).toBeNull();

        // The reported defect: attest() answered `approvals: 2` here while nothing
        // cleared, telling the reviewer the review was done. The count it reports is now
        // the count that decided `clears`, so the two can never disagree.
        expect((await res.json()).outcome.approvals).toBe(1);
    });

    it('a review holding an approval that named nobody exits by board reset, then clears on two real readings', async () => {
        const hh = await twoLeadHousehold('LegacyReset');
        await prisma.backgroundCheckAttestation.create({ data: { processId: hh.processId, reviewerId: rev1, result: 'APPROVE', subjectPersonId: null } });
        as(rev2, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);
        (sendEmail as jest.Mock).mockClear();

        // Both reviewers have spent their one attestation, so neither queue offers it —
        // but the board sees it on /api/membership-ops/applications and `reset` reaches a
        // review still in progress, not only a BLOCKED one. GUARD on that escape hatch:
        // it is why the unnamed approval can be refused rather than counted.
        expect(await eligibleReviewProcessIds(rev1)).not.toContain(hh.processId);
        expect(await eligibleReviewProcessIds(rev2)).not.toContain(hh.processId);
        await boardResetReview(hh.processId, board);
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId: hh.processId } })).toBe(0);

        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);
        as(rev2, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);

        // Two people read Alex's report, and only Alex is stamped.
        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: hh.processId } });
        expect(proc?.bgClearedAt).not.toBeNull();
        expect(proc?.status).toBe('PENDING_PAYMENT');
        expect(await bgDate(hh.alex)).not.toBeNull();
        expect(await bgDate(hh.sam)).toBeNull();
        expect((sendEmail as jest.Mock).mock.calls.some((c: unknown[]) => String(c[1]).includes('you can now pay your membership fee'))).toBe(true);
    });

    // ── A blocked review: no board clearance (Board ruling B5/B25) ────────────
    it('the board cannot clear a blocked review: the override approve is gone (400, nothing stamped)', async () => {
        const hh = await twoLeadHousehold('NoForce');
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'REJECT', note: 'Needs a second look' }) as never);

        as(board, { isBoardMember: true });
        const res = await OVERRIDE(req({ processId: hh.processId, action: 'approve', subjectPersonIds: [hh.alex] }) as never);
        expect(res.status).toBe(400);
        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: hh.processId } });
        expect(proc?.bgClearedAt).toBeNull();
        expect(proc?.status).toBe('BLOCKED');
        expect(await bgDate(hh.alex)).toBeNull();
    });

    it('the rejector changing to approve names one adult, and only that adult is stamped once a second reviewer agrees', async () => {
        const hh = await twoLeadHousehold('SwitchNamed');
        // A current application: consent recorded, so the review it returns to is listed.
        await prisma.orgMembershipProcess.update({ where: { id: hh.processId }, data: { status: 'PENDING_PAYMENT', bgConsentAt: new Date() } });
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'REJECT', note: 'Needs a second look' }) as never);
        const unnamed = await ATTEST(req({ processId: hh.processId, result: 'APPROVE' }) as never);
        expect(unnamed.status).toBe(400);
        const switched = await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);
        expect((await switched.json()).outcome).toEqual({ status: 'PENDING_PAYMENT', approvals: 1 });

        as(rev2, { isBackgroundCheckReviewer: true });
        const second = await ATTEST(req({ processId: hh.processId, result: 'APPROVE', subjectPersonIds: [hh.alex] }) as never);
        expect(second.status).toBe(200);
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: hh.processId } }))?.bgClearedAt).not.toBeNull();
        expect(await bgDate(hh.alex)).not.toBeNull();
        expect(await bgDate(hh.sam)).toBeNull();
    });

    it('a reset needs no subjects — it deletes the attestations and re-opens review', async () => {
        const hh = await twoLeadHousehold('ForceReset');
        as(rev1, { isBackgroundCheckReviewer: true });
        await ATTEST(req({ processId: hh.processId, result: 'REJECT', note: 'Needs a second look' }) as never);

        as(board, { isBoardMember: true });
        const res = await OVERRIDE(req({ processId: hh.processId, action: 'reset' }) as never);
        expect(res.status).toBe(200);
        expect(await prisma.backgroundCheckAttestation.count({ where: { processId: hh.processId } })).toBe(0);
    });

    // ── Remediation worklist ─────────────────────────────────────────────────
    describe('blanket-stamp worklist', () => {
        const CLEARED_AT = new Date('2026-07-15T12:00:00.000Z');

        /** A household as the old blanket stamp left it: every lead stamped with the
         *  process's own bgClearedAt, to the millisecond. */
        async function blanketStamped(label: string, opts: { consentBy?: 'lead' | 'board'; namedAttestation?: boolean } = {}) {
            const hh = await twoLeadHousehold(label);
            await prisma.person.updateMany({ where: { id: { in: [hh.alex, hh.sam] } }, data: { lastBackgroundCheck: CLEARED_AT } });
            await prisma.orgMembershipProcess.update({ where: { id: hh.processId }, data: { bgClearedAt: CLEARED_AT, status: 'PENDING_PAYMENT' } });
            if (opts.namedAttestation) {
                await prisma.backgroundCheckAttestation.create({ data: { processId: hh.processId, reviewerId: rev1, result: 'APPROVE', subjectPersonId: hh.alex } });
            }
            if (opts.consentBy) {
                await prisma.auditLog.create({
                    data: { actorId: opts.consentBy === 'lead' ? hh.alex : board, action: 'EDIT', tableName: 'OrgMembershipProcess', affectedEntityId: hh.processId, newData: { bgConsentAt: true } },
                });
            }
            return hh;
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
            await prisma.orgMembershipProcess.update({ where: { id: single.processId }, data: { bgClearedAt: CLEARED_AT } });

            // Fresh-check shortcut: bgClearedAt set, no Person ever stamped.
            const shortcut = await twoLeadHousehold('Shortcut');
            await prisma.orgMembershipProcess.update({ where: { id: shortcut.processId }, data: { bgClearedAt: CLEARED_AT } });

            // Cleared under per-adult rules: both named, both stamped — correct data.
            const named = await blanketStamped('PerAdult', { namedAttestation: true });

            as(board, { isBoardMember: true });
            const data = await (await COMPLIANCE(get('http://localhost:4000/api/membership-audit/compliance') as never)).json();
            const ids = data.blanketStamped.map((r: { processId: number }) => r.processId);
            expect(ids).not.toContain(single.processId);
            expect(ids).not.toContain(shortcut.processId);
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

    it('flags a background-check date a merge carried over', async () => {
        const hh = await twoLeadHousehold('MergeProvenance');
        const checkedAt = new Date('2026-06-01T09:00:00.000Z');
        // The merge rule takes the later date unconditionally, recording nothing about
        // whose check it was — so the survivor holds a date that traces to no report.
        await prisma.person.update({ where: { id: hh.sam }, data: { lastBackgroundCheck: checkedAt, mergedIntoId: hh.alex } });
        await prisma.person.update({ where: { id: hh.alex }, data: { lastBackgroundCheck: checkedAt } });

        as(board, { isBoardMember: true });
        const data = await (await COMPLIANCE(get('http://localhost:4000/api/membership-audit/compliance') as never)).json();
        expect(data.mergeInheritedBgChecks.map((r: { personId: number }) => r.personId)).toContain(hh.alex);
    });

    // #1456 phase 2b. §6's own comment says this list is permanent, not a cleanup
    // queue — but both its predicate and its `fromName` came from the tombstone
    // Person row, which 2b-3 deletes. The PersonMerge snapshot is what keeps the
    // answer: without it the board stops being told whose check a survivor holds.
    it('still names the source after the merged-away Person row is gone', async () => {
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
        // Sam's Person row never existed as a tombstone here: this is the 2b-3 state,
        // where the archive is the only record of the merge.
        await prisma.person.delete({ where: { id: hh.sam } });

        as(board, { isBoardMember: true });
        const data = await (await COMPLIANCE(get('http://localhost:4000/api/membership-audit/compliance') as never)).json();

        const row = data.mergeInheritedBgChecks.find((r: { personId: number }) => r.personId === hh.alex);
        expect(row).toBeDefined();
        expect(row.fromName).toBe('Sam Archived');
    });

    // Both records exist during 2b, and they say the same thing — so the survivor
    // must appear once, from the archive, not twice.
    it('prefers the archive over the tombstone without double-counting', async () => {
        const hh = await twoLeadHousehold('MergeBoth');
        const checkedAt = new Date('2026-06-01T00:00:00.000Z');
        await prisma.person.update({ where: { id: hh.sam }, data: { lastBackgroundCheck: checkedAt, mergedIntoId: hh.alex, name: 'Stale Tombstone Name' } });
        await prisma.person.update({ where: { id: hh.alex }, data: { lastBackgroundCheck: checkedAt } });
        await prisma.personMerge.create({
            data: {
                fromId: hh.sam,
                toId: hh.alex,
                snapshot: { name: 'Snapshot Name', email: null, lastBackgroundCheck: checkedAt.toISOString() },
            },
        });

        as(board, { isBoardMember: true });
        const data = await (await COMPLIANCE(get('http://localhost:4000/api/membership-audit/compliance') as never)).json();

        const rows = data.mergeInheritedBgChecks.filter((r: { personId: number }) => r.personId === hh.alex);
        expect(rows).toHaveLength(1);
        expect(rows[0].fromName).toBe('Snapshot Name');
    });
});
