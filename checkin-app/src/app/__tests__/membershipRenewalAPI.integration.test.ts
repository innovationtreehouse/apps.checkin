/**
 * @jest-environment node
 */
/**
 * Integration tests for renewal: the cron sweep, beginRenewal (3-yr BG rule),
 * and the renewal background-review path reusing the 2-of-N flow.
 */

import { GET as CRON } from '@/app/api/cron/membership-renewals/route';
import { runRenewalSweep, beginRenewal, nextBoundary } from '@/lib/membership/renewal';
import { attest } from '@/lib/membership/review';
import { markBgConsent, markContractSigned } from '@/lib/membership/external';
import prisma from '@/lib/prisma';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';

jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));

const TAG = 'renewal-test';
const CRON_SECRET = 'cron-test-secret';

function cronReq(token: string | null) {
    return new Request('http://localhost:4000/api/cron/membership-renewals', {
        headers: token ? { authorization: `Bearer ${token}` } : {},
    });
}

describe('Membership renewal', () => {
    const prevSecret = process.env.CRON_SECRET;
    let restoreBoardSettings: () => Promise<void>;
    let rev1: number, rev2: number;
    // The sweep is global; track where we started so afterAll can remove every
    // process this test opened (including renewals on other suites' memberships).
    let preMaxProcessId = 0;

    async function makeActiveMembership(label: string, parentBg: Date | null, leadEmail?: string) {
        const hh = await prisma.household.create({ data: { name: `${label} ${TAG}` } });
        // The guardian is a household lead (drives the 3-yr BG-freshness check).
        const parent = await prisma.person.create({ data: { name: `${label} Parent`, householdId: hh.id, email: leadEmail, lastBackgroundCheck: parentBg ?? undefined } });
        await prisma.person.update({ where: { id: parent.id }, data: { isHouseholdLead: true } });
        const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'ACTIVE' } });
        return { householdId: hh.id, orgMembershipId: m.id, leadEmail, leadId: parent.id };
    }

    async function wipe() {
        const hhs = await prisma.household.findMany({ where: { OR: [{ name: { contains: TAG } }, { householdMembers: { some: { email: { contains: TAG } } } }] }, select: { id: true } });
        const ids = hhs.map((h) => h.id);
        if (ids.length) {
            await prisma.backgroundCheckAttestation.deleteMany({ where: { process: { orgMembership: { householdId: { in: ids } } } } });
            await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: ids } } } });
            await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.household.deleteMany({ where: { id: { in: ids } } });
        }
        await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
    }

    // A real Treehouse-style interval (~2.6yr) so the BG-freshness rule has a configured value.
    const BG_RECHECK_MONTHS = 31;

    async function setBoundary(date: Date | null) {
        await prisma.boardSettings.upsert({
            where: { id: 1 },
            create: { id: 1, standardMembershipFeeCents: 0, volunteerMembershipFeeCents: 0, orgMembershipYearBoundary: date, bgRecheckMonths: BG_RECHECK_MONTHS },
            update: { orgMembershipYearBoundary: date, bgRecheckMonths: BG_RECHECK_MONTHS },
        });
    }

    beforeAll(async () => {
        process.env.CRON_SECRET = CRON_SECRET;
        const maxRow = await prisma.orgMembershipProcess.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
        preMaxProcessId = maxRow?.id ?? 0;
        restoreBoardSettings = await snapshotBoardSettings();
        await wipe();
        const r1 = await prisma.person.create({ data: { email: `rev1-${TAG}@example.com`, name: 'Rev1', isBackgroundCheckReviewer: true, household: { create: { name: `Rev1 HH ${TAG}` } } } });
        rev1 = r1.id;
        rev2 = (await prisma.person.create({ data: { email: `rev2-${TAG}@example.com`, name: 'Rev2', isBackgroundCheckReviewer: true, household: { create: { name: `Rev2 HH ${TAG}` } } } })).id;
    });

    afterAll(async () => {
        // Remove every process (and its attestations) this test's global sweeps opened.
        await prisma.backgroundCheckAttestation.deleteMany({ where: { processId: { gt: preMaxProcessId } } });
        await prisma.orgMembershipProcess.deleteMany({ where: { id: { gt: preMaxProcessId } } });
        await wipe();
        await restoreBoardSettings();
        if (prevSecret === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = prevSecret;
        await prisma.$disconnect();
    });

    // Cron auth negatives are covered centrally in src/lib/__tests__/cronAuth.test.ts;
    // the valid-bearer smoke ('cron runs with a valid bearer') stays below.

    it('nextBoundary rolls to next year when the date has passed', () => {
        const boundary = new Date(Date.UTC(2020, 7, 1)); // Aug 1
        const now = new Date(Date.UTC(2026, 8, 15)); // Sep 15 2026 (past Aug 1)
        expect(nextBoundary(boundary, now).getUTCFullYear()).toBe(2027);
    });

    it('does nothing outside the renewal window', async () => {
        await setBoundary(new Date(Date.UTC(2000, 7, 1))); // Aug 1
        const res = await runRenewalSweep(new Date(Date.UTC(2026, 0, 1))); // Jan — far from Aug
        expect(res.opened).toBe(0);
    });

    it('opens a PENDING_RENEWAL process within the window, once, without emailing (PR-2: the machine never emails)', async () => {
        await setBoundary(new Date(Date.UTC(2000, 7, 1))); // Aug 1
        const m = await makeActiveMembership('Due', null, `due-lead-${TAG}@example.com`);
        const now = new Date(Date.UTC(2026, 6, 1)); // Jul 1 — within 2 months before Aug 1

        const { sendEmail } = jest.requireMock('@/lib/email') as { sendEmail: jest.Mock };
        sendEmail.mockClear();

        const first = await runRenewalSweep(now);
        expect(first.opened).toBeGreaterThanOrEqual(1);
        const proc = await prisma.orgMembershipProcess.findFirst({ where: { orgMembershipId: m.orgMembershipId } });
        expect(proc?.status).toBe('PENDING_RENEWAL');
        expect(proc?.kind).toBe('RENEWAL');

        // The sweep no longer reminds — the settings/outreach page is the only send surface.
        expect(sendEmail).not.toHaveBeenCalled();

        const second = await runRenewalSweep(now);
        const count = await prisma.orgMembershipProcess.count({ where: { orgMembershipId: m.orgMembershipId } });
        expect(count).toBe(1); // not duplicated
        expect(second).toBeDefined();
    });

    it('does not re-open for a household already renewed this cycle (terminal RENEWAL in-window)', async () => {
        await setBoundary(new Date(Date.UTC(2000, 7, 1))); // Aug 1
        const now = new Date(Date.UTC(2026, 6, 1)); // Jul 1 — within the window
        const m = await makeActiveMembership('Renewed', null, `renewed-lead-${TAG}@example.com`);
        // A completed renewal this cycle (early finisher, or the admin coming-year
        // override): terminal ACTIVE RENEWAL with stageEnteredAt inside the window.
        await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: m.orgMembershipId, kind: 'RENEWAL', status: 'ACTIVE', stageEnteredAt: now },
        });

        await runRenewalSweep(now);

        // No fresh PENDING_RENEWAL opened — the terminal row counts as handled.
        const opened = await prisma.orgMembershipProcess.findFirst({
            where: { orgMembershipId: m.orgMembershipId, status: 'PENDING_RENEWAL' },
        });
        expect(opened).toBeNull();
        const count = await prisma.orgMembershipProcess.count({ where: { orgMembershipId: m.orgMembershipId } });
        expect(count).toBe(1);
    });

    it('beginRenewal with a valid parent background check: re-sign only — bgClearedAt stamped, signature opens payment', async () => {
        await setBoundary(new Date(Date.UTC(2000, 7, 1)));
        const m = await makeActiveMembership('Fresh', new Date()); // recent background check
        const proc = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.orgMembershipId, kind: 'RENEWAL', status: 'PENDING_RENEWAL' } });
        const out = await beginRenewal(proc.id, m.leadId);
        // A fresh agreement is signed every cycle; the still-valid background check is
        // pre-cleared, so the signature alone opens payment.
        expect(out.status).toBe('PENDING_EXTERNAL_ACTION');
        expect(out.bgClearedAt).not.toBeNull();

        await markContractSigned(proc.id);
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: proc.id } }))?.status).toBe('PENDING_PAYMENT');
    });

    it('beginRenewal with an expired background check requires signature + consent; payment opens; review clears in parallel', async () => {
        await setBoundary(new Date(Date.UTC(2000, 7, 1)));
        const m = await makeActiveMembership('Stale', null); // no background check on record
        const proc = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.orgMembershipId, kind: 'RENEWAL', status: 'PENDING_RENEWAL' } });
        const out = await beginRenewal(proc.id, m.leadId);
        // Same external step as a new applicant — the member must sign a fresh
        // agreement AND consent on Averity; nothing sits in the review queue yet.
        expect(out.status).toBe('PENDING_EXTERNAL_ACTION');
        expect(out.bgClearedAt).toBeNull();
        await expect(attest(rev1, proc.id, { result: 'APPROVE', subjectPersonIds: [m.leadId] })).rejects.toMatchObject({ code: 'wrong_phase' });

        // Consent alone is not enough — the renewal re-signs the agreement too.
        await markBgConsent(proc.id, rev1);
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: proc.id } }))?.status).toBe('PENDING_EXTERNAL_ACTION');

        // Signature lands → payment opens; the 2-of-N review runs in parallel:
        // 2 approvals keep it at PENDING_PAYMENT (unpaid) rather than blocking it.
        await markContractSigned(proc.id);
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: proc.id } }))?.status).toBe('PENDING_PAYMENT');

        await attest(rev1, proc.id, { result: 'APPROVE', subjectPersonIds: [m.leadId] });
        const final = await attest(rev2, proc.id, { result: 'APPROVE', subjectPersonIds: [m.leadId] });
        expect(final.status).toBe('PENDING_PAYMENT');
    });

    it('cron runs with a valid bearer', async () => {
        // Far-future boundary so the real-time sweep is a no-op (no global pollution).
        await setBoundary(new Date(Date.now() + 150 * 24 * 3600 * 1000));
        const res = await CRON(cronReq(CRON_SECRET));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
    });
});
