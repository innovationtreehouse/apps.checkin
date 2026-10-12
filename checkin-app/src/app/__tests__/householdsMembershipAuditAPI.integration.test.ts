/**
 * @jest-environment node
 */
/**
 * Integration tests for audit logging on the board grant/revoke membership
 * actions in POST /api/membership-ops/households — granting (ACTIVE) and revoking
 * (REVOKED) must each write an AuditLog row recording who acted and what changed.
 *
 * Also covers the "Grant for coming year" override: it comps the PAYMENT gate on
 * a household's in-flight RENEWAL at PENDING_PAYMENT — never archives, never
 * bypasses BG. A bgClearedAt row settles to ACTIVE; a parallel-track row
 * (bgClearedAt null, BG still in review) settles to PENDING_BG_CLEARANCE and
 * stays INACTIVE until reviewers clear it.
 */

import { POST } from '@/app/api/membership-ops/households/route';
import prisma from '@/lib/prisma';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

const TAG = 'membership-audit-test';
// A real Treehouse-style interval so the BG-freshness rule has a configured value.
const BG_RECHECK_MONTHS = 31;
const BOUNDARY = new Date(Date.UTC(2000, 7, 1)); // Aug 1 (year rolls forward)

function post(body: unknown) {
    return POST(new Request('http://localhost:4000/api/membership-ops/households', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest);
}

describe('POST /api/membership-ops/households — grant/revoke audit logging', () => {
    let boardId: number;
    let boardHouseholdId: number;
    let boardProcessId: number;
    let inactiveHouseholdId: number;
    let activeHouseholdId: number;
    let noRenewalHouseholdId: number;
    let pendingRenewalHouseholdId: number;
    let pendingExternalHouseholdId: number;
    let midFlowHouseholdId: number;
    let midFlowProcessId: number;
    let bgNotFreshHouseholdId: number;
    let bgNotFreshProcessId: number;
    let grantableHouseholdId: number;
    let grantableProcessId: number;
    let grantableMembershipId: number;

    let restoreBoardSettings: () => Promise<void> = async () => {};

    // A household with one person, no lead/BG stamped unless the caller sets it.
    async function makeHousehold(label: string) {
        const person = await prisma.person.create({
            data: { email: `${label}-${TAG}@example.com`, name: label, household: { create: { name: `${label} ${TAG}` } } },
        });
        return person.householdId;
    }

    async function setLead(householdId: number, lastBackgroundCheck: Date | null) {
        await prisma.person.updateMany({ where: { householdId }, data: { isHouseholdLead: true, lastBackgroundCheck } });
    }

    beforeAll(async () => {
        const leaked = await prisma.person.findMany({
            where: { email: { contains: TAG } }, select: { id: true },
        });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: leaked.map(u => u.id) } } });
        await prisma.person.deleteMany({ where: { email: { contains: TAG } } });

        restoreBoardSettings = await snapshotBoardSettings();
        await prisma.boardSettings.upsert({
            where: { id: 1 },
            create: { id: 1, standardMembershipFeeCents: 0, volunteerMembershipFeeCents: 0, orgMembershipYearBoundary: BOUNDARY, bgRecheckMonths: BG_RECHECK_MONTHS },
            update: { orgMembershipYearBoundary: BOUNDARY, bgRecheckMonths: BG_RECHECK_MONTHS },
        });

        // Acting board member (in their own household). Also given a grantable
        // renewal so the own-household COI test exercises the real 403, not a
        // 409-no-renewal masking it.
        const board = await prisma.person.create({
            data: { email: `board-${TAG}@example.com`, name: 'Board Actor', isBoardMember: true, isHouseholdLead: true, lastBackgroundCheck: new Date(), household: { create: { name: "Test HH" } } },
        });
        boardId = board.id;
        boardHouseholdId = board.householdId;
        const boardMembership = await prisma.orgMembership.create({ data: { householdId: boardHouseholdId, status: 'NONE' } });
        boardProcessId = (await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: boardMembership.id, kind: 'RENEWAL', status: 'PENDING_PAYMENT', bgClearedAt: new Date() },
        })).id;

        // A household with no membership row → will be granted (ACTIVE).
        const inactive = await prisma.person.create({
            data: { email: `inactive-${TAG}@example.com`, name: 'Inactive Member', household: { create: { name: "Test HH" } } },
        });
        inactiveHouseholdId = inactive.householdId;

        // A household that is already ACTIVE → will be revoked (REVOKED).
        const active = await prisma.person.create({
            data: { email: `active-${TAG}@example.com`, name: 'Active Member', household: { create: { name: "Test HH" } } },
        });
        activeHouseholdId = active.householdId;
        await prisma.orgMembership.create({ data: { householdId: activeHouseholdId, status: 'ACTIVE' } });

        // No RENEWAL process at all → 409 (no renewal awaiting payment).
        noRenewalHouseholdId = await makeHousehold('norenewal');
        await prisma.orgMembership.create({ data: { householdId: noRenewalHouseholdId, status: 'ACTIVE' } });

        // RENEWAL opened by the sweep, member hasn't engaged yet → 409.
        pendingRenewalHouseholdId = await makeHousehold('pendingrenewal');
        const prMembership = await prisma.orgMembership.create({ data: { householdId: pendingRenewalHouseholdId, status: 'ACTIVE' } });
        await prisma.orgMembershipProcess.create({ data: { orgMembershipId: prMembership.id, kind: 'RENEWAL', status: 'PENDING_RENEWAL' } });

        // RENEWAL awaiting the external step (sign + maybe BG consent) → 409.
        pendingExternalHouseholdId = await makeHousehold('pendingexternal');
        const peMembership = await prisma.orgMembership.create({ data: { householdId: pendingExternalHouseholdId, status: 'ACTIVE' } });
        await prisma.orgMembershipProcess.create({ data: { orgMembershipId: peMembership.id, kind: 'RENEWAL', status: 'PENDING_EXTERNAL_ACTION' } });

        // Parallel-track: PENDING_PAYMENT with bgClearedAt null, BG consent recorded
        // (review runs in parallel). Grant comps payment → PENDING_BG_CLEARANCE (200).
        midFlowHouseholdId = await makeHousehold('midflow');
        const midMembership = await prisma.orgMembership.create({ data: { householdId: midFlowHouseholdId, status: 'ACTIVE' } });
        midFlowProcessId = (await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: midMembership.id, kind: 'RENEWAL', status: 'PENDING_PAYMENT', bgConsentAt: new Date() },
        })).id;
        await setLead(midFlowHouseholdId, new Date());

        // PENDING_PAYMENT with bgClearedAt set, no lead has a fresh check. Grant comps
        // payment; BG is already cleared on the process → settles to ACTIVE (200).
        bgNotFreshHouseholdId = await makeHousehold('bgnotfresh');
        const bnfMembership = await prisma.orgMembership.create({ data: { householdId: bgNotFreshHouseholdId, status: 'ACTIVE' } });
        bgNotFreshProcessId = (await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: bnfMembership.id, kind: 'RENEWAL', status: 'PENDING_PAYMENT', bgClearedAt: new Date() },
        })).id;
        await setLead(bgNotFreshHouseholdId, null);

        // PENDING_PAYMENT + bgClearedAt + fresh lead BG → grantable (success case).
        grantableHouseholdId = await makeHousehold('grantable');
        const grMembership = await prisma.orgMembership.create({ data: { householdId: grantableHouseholdId, status: 'ACTIVE' } });
        grantableMembershipId = grMembership.id;
        grantableProcessId = (await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: grMembership.id, kind: 'RENEWAL', status: 'PENDING_PAYMENT', bgClearedAt: new Date() },
        })).id;
        await setLead(grantableHouseholdId, new Date());
    });

    afterAll(async () => {
        const ids = await prisma.person.findMany({
            where: { email: { contains: TAG } }, select: { id: true, householdId: true },
        });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: ids.map(u => u.id) } } });
        const memberships = await prisma.orgMembership.findMany({
            where: { householdId: { in: ids.map(u => u.householdId) } }, select: { id: true },
        });
        // Processes FK onto membership with onDelete Restrict — clear them first.
        await prisma.orgMembershipProcess.deleteMany({ where: { orgMembershipId: { in: memberships.map(m => m.id) } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids.map(u => u.householdId) } } });
        await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
        await prisma.household.deleteMany({ where: { id: { in: ids.map(u => u.householdId) } } });
        await restoreBoardSettings();
    });

    it('grants an inactive household, sets ACTIVE, and writes an audit row', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

        const res = await post({ householdId: inactiveHouseholdId, active: true });
        expect(res.status).toBe(200);

        const membership = await prisma.orgMembership.findUnique({ where: { householdId: inactiveHouseholdId } });
        expect(membership?.status).toBe('ACTIVE');

        const audit = await prisma.auditLog.findFirst({
            where: { actorId: boardId, tableName: 'OrgMembership', affectedEntityId: membership!.id },
            orderBy: { id: 'desc' },
        });
        expect(audit).not.toBeNull();
        expect(audit!.actorId).toBe(boardId);
        expect((audit!.newData as { status: string }).status).toBe('ACTIVE');
    });

    it("refuses to grant the actor's OWN household (conflict of interest), sysadmin included", async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
        const res = await post({ householdId: boardHouseholdId, active: true });
        expect(res.status).toBe(403);
        const before = await prisma.orgMembership.findUnique({ where: { householdId: boardHouseholdId } });
        expect(before?.status ?? 'NONE').not.toBe('ACTIVE'); // not granted

        // Holding sysadmin — alone or alongside board — buys no way through.
        for (const roles of [{ isSysadmin: true }, { isBoardMember: true, isSysadmin: true }]) {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, ...roles } });
            const denied = await post({ householdId: boardHouseholdId, active: true });
            expect(denied.status).toBe(403);
            const after = await prisma.orgMembership.findUnique({ where: { householdId: boardHouseholdId } });
            expect(after?.status ?? 'NONE').not.toBe('ACTIVE');
        }
    });

    it('coming-year grant: no in-flight renewal → 409, no mutation', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

        const res = await post({ householdId: noRenewalHouseholdId, comingYear: true, reason: 'Renewal grant test' });
        expect(res.status).toBe(409);

        const membership = await prisma.orgMembership.findUnique({ where: { householdId: noRenewalHouseholdId } });
        expect(membership?.status).toBe('ACTIVE'); // unchanged from fixture setup
        const processCount = await prisma.orgMembershipProcess.count({ where: { orgMembershipId: membership!.id } });
        expect(processCount).toBe(0);
    });

    it('coming-year grant: renewal at PENDING_RENEWAL (not started) → 409, unchanged', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

        const res = await post({ householdId: pendingRenewalHouseholdId, comingYear: true, reason: 'Renewal grant test' });
        expect(res.status).toBe(409);

        const membership = await prisma.orgMembership.findUnique({ where: { householdId: pendingRenewalHouseholdId } });
        const process = await prisma.orgMembershipProcess.findFirst({ where: { orgMembershipId: membership!.id } });
        expect(process?.status).toBe('PENDING_RENEWAL');
    });

    it('coming-year grant: renewal at PENDING_EXTERNAL_ACTION → 409, unchanged', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

        const res = await post({ householdId: pendingExternalHouseholdId, comingYear: true, reason: 'Renewal grant test' });
        expect(res.status).toBe(409);

        const membership = await prisma.orgMembership.findUnique({ where: { householdId: pendingExternalHouseholdId } });
        const process = await prisma.orgMembershipProcess.findFirst({ where: { orgMembershipId: membership!.id } });
        expect(process?.status).toBe('PENDING_EXTERNAL_ACTION');
    });

    it('coming-year grant: parallel-track (PENDING_PAYMENT, bgClearedAt null) → 200, settles to PENDING_BG_CLEARANCE (payment comped, BG still gating)', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

        const res = await post({ householdId: midFlowHouseholdId, comingYear: true, reason: 'Renewal grant test' });
        expect(res.status).toBe(200);

        // BG gate NOT bypassed: process parks at PENDING_BG_CLEARANCE (paid, awaiting
        // the check), NOT ACTIVE — reviewers must still clear it.
        const process = await prisma.orgMembershipProcess.findUnique({ where: { id: midFlowProcessId } });
        expect(process?.status).toBe('PENDING_BG_CLEARANCE');
        expect(process?.paidAt).not.toBeNull();
    });

    it("coming-year grant: bgClearedAt set but no household lead has a fresh check → 200, settles to ACTIVE (BG already cleared on the process)", async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

        const res = await post({ householdId: bgNotFreshHouseholdId, comingYear: true, reason: 'Renewal grant test' });
        expect(res.status).toBe(200);

        const process = await prisma.orgMembershipProcess.findUnique({ where: { id: bgNotFreshProcessId } });
        expect(process?.status).toBe('ACTIVE');
        expect(process?.paidAt).not.toBeNull();
    });

    it("refuses coming-year grant for the actor's OWN household (conflict of interest), sysadmin included", async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
        const res = await post({ householdId: boardHouseholdId, comingYear: true, reason: 'Renewal grant test' });
        expect(res.status).toBe(403);
        const stillPending = await prisma.orgMembershipProcess.findUnique({ where: { id: boardProcessId } });
        expect(stillPending?.status).toBe('PENDING_PAYMENT');

        // The comingYear branch reaches the same guard through grantRenewalPayment →
        // certifyPaymentPlan, so sysadmin gets no separate door here either.
        for (const roles of [{ isSysadmin: true }, { isBoardMember: true, isSysadmin: true }]) {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, ...roles } });
            const denied = await post({ householdId: boardHouseholdId, comingYear: true, reason: 'Renewal grant test' });
            expect(denied.status).toBe(403);
            const unsettled = await prisma.orgMembershipProcess.findUnique({ where: { id: boardProcessId } });
            expect(unsettled?.status).toBe('PENDING_PAYMENT');
        }
    });

    it('coming-year grant: missing reason → 400, no mutation', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

        const res = await post({ householdId: grantableHouseholdId, comingYear: true });
        expect(res.status).toBe(400);

        const process = await prisma.orgMembershipProcess.findUnique({ where: { id: grantableProcessId } });
        expect(process?.status).toBe('PENDING_PAYMENT');
        expect(process?.paidAt).toBeNull();

        // Whitespace-only reason is treated the same as missing.
        const res2 = await post({ householdId: grantableHouseholdId, comingYear: true, reason: '   ' });
        expect(res2.status).toBe(400);
    });

    it('coming-year grant: PENDING_PAYMENT + bgClearedAt + fresh lead BG → 200, completes payment (no archive, no 2nd process)', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

        const res = await post({ householdId: grantableHouseholdId, comingYear: true, reason: 'Family confirmed dues in person at the board meeting.' });
        expect(res.status).toBe(200);

        const membership = await prisma.orgMembership.findUnique({ where: { householdId: grantableHouseholdId } });
        expect(membership?.status).toBe('ACTIVE');

        // The SAME process settles — no archive, no second process created.
        const process = await prisma.orgMembershipProcess.findUnique({ where: { id: grantableProcessId } });
        expect(process?.status).toBe('ACTIVE');
        expect(process?.paidAt).not.toBeNull();
        expect(process?.manualPaymentById).toBe(boardId);
        expect(process?.certificationNote).toBe('Family confirmed dues in person at the board meeting.');
        const processCount = await prisma.orgMembershipProcess.count({ where: { orgMembershipId: grantableMembershipId } });
        expect(processCount).toBe(1);

        // Both the activate() transition audit (written first, inside
        // certifyPaymentPlan) and the supplementary grant marker (written after)
        // must exist for this process.
        const audits = await prisma.auditLog.findMany({
            where: { actorId: boardId, tableName: 'OrgMembershipProcess', affectedEntityId: grantableProcessId },
            orderBy: { id: 'asc' },
        });
        const activateAudit = audits.find(a => (a.newData as { status?: string })?.status === 'ACTIVE');
        expect(activateAudit).toBeTruthy();
        expect((activateAudit!.newData as { via: string }).via).toBe('manual');
        expect((activateAudit!.newData as { certificationNote?: string }).certificationNote).toBe('Family confirmed dues in person at the board meeting.');
        const grantAudit = audits.find(a => (a.newData as { comingYearGrant?: boolean })?.comingYearGrant === true);
        expect(grantAudit).toBeTruthy();
        expect((grantAudit!.newData as { reason?: string }).reason).toBe('Family confirmed dues in person at the board meeting.');
    });

    it('revokes an active household, sets REVOKED, and writes an audit row', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

        const res = await post({ householdId: activeHouseholdId, active: false });
        expect(res.status).toBe(200);

        const membership = await prisma.orgMembership.findUnique({ where: { householdId: activeHouseholdId } });
        expect(membership?.status).toBe('REVOKED');

        const audit = await prisma.auditLog.findFirst({
            where: { actorId: boardId, tableName: 'OrgMembership', affectedEntityId: membership!.id },
            orderBy: { id: 'desc' },
        });
        expect(audit).not.toBeNull();
        expect(audit!.actorId).toBe(boardId);
        expect((audit!.oldData as { status: string }).status).toBe('ACTIVE');
        expect((audit!.newData as { status: string }).status).toBe('REVOKED');
    });
});
