/**
 * @jest-environment node
 */
/**
 * Integration tests for the board's "Close application" (archive in code) on a
 * long-idle, unpaid process (drops off the board list, audit row): refuses paid,
 * BLOCKED, PENDING_BG_CLEARANCE and ACTIVE (409), the actor's own household (403),
 * non-board (403); idempotent no-op.
 * Also the applicant side: a disposed process is terminal — a returning applicant
 * sees a clean slate, can file a fresh application (past the partial unique index),
 * and cannot resume or submit the archived one.
 *
 * Also covers "Reopen" (unarchive): round-trips back to the status captured on the
 * row at close time, re-runs the external advance, and refuses when there's nothing
 * to restore, the household is DENIED, or another application is open.
 *
 * And "Record refund": PENDING_BG_CLEARANCE → PENDING_PAYMENT clearing paidAt; a paid
 * BLOCKED row only loses paidAt.
 */

import { POST as ARCHIVE } from '@/app/api/membership-ops/applications/archive/route';
import { POST as UNARCHIVE } from '@/app/api/membership-ops/applications/unarchive/route';
import { GET as ADMIN_LIST } from '@/app/api/membership-ops/applications/route';
import { getIntakeState, startIntake, submitIntake } from '@/lib/membership/intake';
import { recordRefund } from '@/lib/membership/refund';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const TAG = 'membership-archive-test';

function asBoard(id: number) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isSysadmin: false, isBoardMember: true } });
}
function asUser(id: number) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isSysadmin: false, isBoardMember: false } });
}
function req(body: unknown) {
    return new Request('http://localhost:4000/api/membership-ops/applications/archive', {
        method: 'POST',
        body: JSON.stringify(body),
    }) as unknown as Parameters<typeof ARCHIVE>[0];
}
function unarchiveReq(body: unknown) {
    return new Request('http://localhost:4000/api/membership-ops/applications/unarchive', {
        method: 'POST',
        body: JSON.stringify(body),
    }) as unknown as Parameters<typeof UNARCHIVE>[0];
}
function listReq() {
    return new Request('http://localhost:4000/api/membership-ops/applications') as unknown as Parameters<typeof ADMIN_LIST>[0];
}
function archivedListReq() {
    return new Request('http://localhost:4000/api/membership-ops/applications?archived=1') as unknown as Parameters<typeof ADMIN_LIST>[0];
}

type Status = 'INTAKE' | 'PENDING_EXTERNAL_ACTION' | 'PENDING_PAYMENT' | 'PENDING_BG_CLEARANCE' | 'BLOCKED' | 'ACTIVE';
async function makeProcess(label: string, status: Status, extra: { paidAt?: Date; membershipStatus?: 'NONE' | 'DENIED' } = {}) {
    const hh = await prisma.household.create({ data: { name: `${label} ${TAG}` } });
    const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: extra.membershipStatus ?? 'NONE' } });
    const p = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.id, kind: 'INITIAL', status, paidAt: extra.paidAt ?? null } });
    return { householdId: hh.id, membershipId: m.id, processId: p.id };
}

// A full applicant household: a lead (guardian) + membership + INITIAL process,
// so the intake service (getIntakeState/startIntake/submitIntake) can run.
async function makeApplicant(label: string, status: 'INTAKE' | 'PENDING_PAYMENT') {
    const hh = await prisma.household.create({ data: { name: `${label} ${TAG}` } });
    const lead = await prisma.person.create({ data: { name: `${label} Parent`, householdId: hh.id, isHouseholdLead: true } });
    const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
    const p = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.id, kind: 'INITIAL', status } });
    return { householdId: hh.id, membershipId: m.id, userId: lead.id, processId: p.id };
}

async function wipe() {
    const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = hhs.map((h) => h.id);
    if (ids.length) {
        await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: ids } } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
}

describe('Membership application archive API', () => {
    let boardId: number, plainId: number;

    beforeAll(async () => {
        await wipe();
        boardId = (await prisma.person.create({ data: { name: 'board', email: `board-${TAG}@example.com`, isBoardMember: true, household: { create: { name: `board HH ${TAG}` } } } })).id;
        plainId = (await prisma.person.create({ data: { name: 'plain', email: `plain-${TAG}@example.com`, household: { create: { name: `plain HH ${TAG}` } } } })).id;
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    it.each(['INTAKE', 'PENDING_EXTERNAL_ACTION', 'PENDING_PAYMENT'] as const)(
        'board archives a stale %s process → status ARCHIVED, drops off the list, audit written',
        async (status) => {
            const { processId } = await makeProcess(`Stale-${status}`, status);
            asBoard(boardId);
            const res = await ARCHIVE(req({ processId }) as never);
            expect(res.status).toBe(200);

            // Transitions to the terminal ARCHIVED status (single declarative axis).
            const after = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
            expect(after?.status).toBe('ARCHIVED');

            // No longer surfaces on the board applications list.
            const listRes = await ADMIN_LIST(listReq() as never);
            const listed = (await listRes.json()).processes.map((p: { id: number }) => p.id);
            expect(listed).not.toContain(processId);

            // The audit row captures who + the phase it was archived from.
            const audit = await prisma.auditLog.findFirst({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: processId }, orderBy: { id: 'desc' } });
            expect(audit?.actorId).toBe(boardId);
            expect(audit?.oldData).toMatchObject({ status });
            expect(audit?.newData).toMatchObject({ status: 'ARCHIVED' });
        },
    );

    it('refuses to archive an ACTIVE membership (409 wrong_phase), state unchanged', async () => {
        const { processId } = await makeProcess('Active', 'ACTIVE');
        asBoard(boardId);
        const res = await ARCHIVE(req({ processId }) as never);
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('wrong_phase');
        const after = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(after?.status).toBe('ACTIVE');
    });

    it.each([
        ['a paid PENDING_PAYMENT', 'PENDING_PAYMENT', new Date()],
        ['a BLOCKED', 'BLOCKED', undefined],
        ['a paid PENDING_BG_CLEARANCE', 'PENDING_BG_CLEARANCE', new Date()],
    ] as const)('refuses to close %s application (409 wrong_phase), state unchanged', async (_label, status, paidAt) => {
        const { processId } = await makeProcess(`NoClose-${status}`, status, { paidAt });
        asBoard(boardId);
        const res = await ARCHIVE(req({ processId }) as never);
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('wrong_phase');
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: processId } }))?.status).toBe(status);
    });

    it('refuses to close or reopen your own household application (403)', async () => {
        const { householdId, processId } = await makeProcess('OwnHH', 'INTAKE');
        const selfBoard = await prisma.person.create({ data: { name: 'self board', isBoardMember: true, householdId } });
        asBoard(selfBoard.id);
        expect((await ARCHIVE(req({ processId }) as never)).status).toBe(403);
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: processId } }))?.status).toBe('INTAKE');

        await prisma.orgMembershipProcess.update({ where: { id: processId }, data: { status: 'ARCHIVED', archivedFromStatus: 'INTAKE' } });
        expect((await UNARCHIVE(unarchiveReq({ processId }) as never)).status).toBe(403);
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: processId } }))?.status).toBe('ARCHIVED');
    });

    it('rejects a non-board user (403)', async () => {
        const { processId } = await makeProcess('Forbidden', 'INTAKE');
        asUser(plainId);
        const res = await ARCHIVE(req({ processId }) as never);
        expect(res.status).toBe(403);
        const after = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(after?.status).toBe('INTAKE');
    });

    it('archiving an already-archived process is an idempotent no-op (200, no second audit)', async () => {
        const { processId } = await makeProcess('Idempotent', 'INTAKE');
        asBoard(boardId);
        await ARCHIVE(req({ processId }) as never);
        const auditCount = () => prisma.auditLog.count({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: processId } });
        const before = await auditCount();

        const res = await ARCHIVE(req({ processId }) as never);
        expect(res.status).toBe(200);
        const second = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(second?.status).toBe('ARCHIVED');
        expect(await auditCount()).toBe(before);
    });

    it('archiving a non-existent process returns 404 not_found', async () => {
        asBoard(boardId);
        const res = await ARCHIVE(req({ processId: 999999999 }) as never);
        expect(res.status).toBe(404);
        expect((await res.json()).code).toBe('not_found');
    });

    // --- applicant side: a disposed process is terminal ---

    it('after archive, the applicant sees a clean slate and can file a fresh application', async () => {
        const { userId, processId, membershipId } = await makeApplicant('Returning', 'INTAKE');
        asBoard(boardId);
        await ARCHIVE(req({ processId }) as never);

        // Clean slate: the disposed process no longer surfaces as in-flight.
        const state = await getIntakeState(userId);
        expect(state.process).toBeNull();

        // Start again → a brand-new process, not the archived one, and no P2002 from
        // the partial unique index (ARCHIVED isn't in its in-flight status set, so
        // the disposed row no longer occupies the one-in-flight slot).
        const fresh = await startIntake(userId);
        expect(fresh.id).not.toBe(processId);
        expect(fresh.status).toBe('INTAKE');
        expect(fresh.orgMembershipId).toBe(membershipId);

        // The archived process is untouched — still on record, terminal ARCHIVED.
        const old = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(old?.status).toBe('ARCHIVED');
    });

    it('a board-archived INTAKE cannot be resumed or submitted', async () => {
        const { userId, processId } = await makeApplicant('NoResume', 'INTAKE');
        asBoard(boardId);
        await ARCHIVE(req({ processId }) as never);

        // startIntake must not hand back the archived process — it opens a new one.
        const started = await startIntake(userId);
        expect(started.id).not.toBe(processId);

        // submitIntake only ever targets a live INTAKE — archive the fresh one too
        // and confirm submit finds no process to act on.
        await prisma.orgMembershipProcess.update({ where: { id: started.id }, data: { status: 'ARCHIVED' } });
        await expect(submitIntake(userId)).rejects.toMatchObject({ code: 'no_process' });
    });

    // --- board recovery: unarchive ---

    it('archive→unarchive round-trip restores the captured prior status', async () => {
        const { processId } = await makeProcess('RoundTrip', 'PENDING_PAYMENT');
        asBoard(boardId);
        await ARCHIVE(req({ processId }) as never);
        const archived = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(archived?.status).toBe('ARCHIVED');
        // The archive write captured the collapsed phase on the row itself.
        expect(archived?.archivedFromStatus).toBe('PENDING_PAYMENT');
        await new Promise((r) => setTimeout(r, 5)); // ensure stageEnteredAt strictly advances

        const res = await UNARCHIVE(unarchiveReq({ processId }) as never);
        expect(res.status).toBe(200);
        expect((await res.json()).outcome).toEqual({ status: 'PENDING_PAYMENT' });

        const after = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(after?.status).toBe('PENDING_PAYMENT');
        expect(after?.archivedFromStatus).toBeNull();
        expect(after!.stageEnteredAt!.getTime()).toBeGreaterThan(archived!.stageEnteredAt!.getTime());

        const audit = await prisma.auditLog.findFirst({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: processId }, orderBy: { id: 'desc' } });
        expect(audit?.actorId).toBe(boardId);
        expect(audit?.oldData).toMatchObject({ status: 'ARCHIVED' });
        expect(audit?.newData).toMatchObject({ status: 'PENDING_PAYMENT', unarchived: true });
    });

    it('reopens a renewal closed from the legacy RENEWAL_PENDING_BG', async () => {
        // Rows closed under the older, wider rule (and backfilled by migration
        // 20260806160000) may hold it; nothing closes into it any more.
        const hh = await prisma.household.create({ data: { name: `LegacyRenewal ${TAG}` } });
        const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'ACTIVE' } });
        const p = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.id, kind: 'RENEWAL', status: 'ARCHIVED', archivedFromStatus: 'RENEWAL_PENDING_BG' } });
        asBoard(boardId);

        const res = await UNARCHIVE(unarchiveReq({ processId: p.id }) as never);
        expect(res.status).toBe(200);

        const after = await prisma.orgMembershipProcess.findUnique({ where: { id: p.id } });
        expect({ status: after?.status, from: after?.archivedFromStatus }).toEqual({ status: 'RENEWAL_PENDING_BG', from: null });
    });

    it('reopens a row closed from BLOCKED under the old rule as BLOCKED', async () => {
        const { processId } = await makeProcess('LegacyBlocked', 'BLOCKED');
        await prisma.orgMembershipProcess.update({ where: { id: processId }, data: { status: 'ARCHIVED', archivedFromStatus: 'BLOCKED' } });
        asBoard(boardId);
        expect((await UNARCHIVE(unarchiveReq({ processId }) as never)).status).toBe(200);
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: processId } }))?.status).toBe('BLOCKED');
    });

    it('reopen re-runs the external advance when the gate was met while closed', async () => {
        const { processId } = await makeProcess('Advance', 'PENDING_EXTERNAL_ACTION');
        asBoard(boardId);
        await ARCHIVE(req({ processId }) as never);
        await prisma.orgMembershipProcess.update({ where: { id: processId }, data: { contractSignedAt: new Date(), bgConsentAt: new Date() } });

        const res = await UNARCHIVE(unarchiveReq({ processId }) as never);
        expect(res.status).toBe(200);
        expect((await res.json()).outcome.status).toBe('PENDING_PAYMENT');
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: processId } }))?.status).toBe('PENDING_PAYMENT');
    });

    it('refuses to reopen when the household is now DENIED (409, says why)', async () => {
        const { processId, membershipId } = await makeProcess('Denied', 'INTAKE');
        asBoard(boardId);
        await ARCHIVE(req({ processId }) as never);
        await prisma.orgMembership.update({ where: { id: membershipId }, data: { status: 'DENIED' } });

        const res = await UNARCHIVE(unarchiveReq({ processId }) as never);
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/denied/i);
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: processId } }))?.status).toBe('ARCHIVED');
    });

    it('refuses to reopen while the household has a BLOCKED application (409)', async () => {
        const { processId, membershipId } = await makeProcess('BlockedSibling', 'INTAKE');
        asBoard(boardId);
        await ARCHIVE(req({ processId }) as never);
        await prisma.orgMembershipProcess.create({ data: { orgMembershipId: membershipId, kind: 'RENEWAL', status: 'BLOCKED' } });

        const res = await UNARCHIVE(unarchiveReq({ processId }) as never);
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/already open/i);
    });

    it('refuses to unarchive a non-archived process (409 wrong_phase)', async () => {
        const { processId } = await makeProcess('NotArchived', 'PENDING_PAYMENT');
        asBoard(boardId);
        const res = await UNARCHIVE(unarchiveReq({ processId }) as never);
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('wrong_phase');
    });

    it('refuses to unarchive when a second in-flight process of the same kind now exists (409 wrong_phase)', async () => {
        const hh = await prisma.household.create({ data: { name: `Conflict ${TAG}` } });
        const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
        const p1 = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.id, kind: 'INITIAL', status: 'PENDING_PAYMENT' } });
        asBoard(boardId);
        await ARCHIVE(req({ processId: p1.id }) as never);

        // A second in-flight INITIAL process opens for the same membership while p1 sits archived.
        await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.id, kind: 'INITIAL', status: 'INTAKE' } });

        const res = await UNARCHIVE(unarchiveReq({ processId: p1.id }) as never);
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('wrong_phase');

        // p1 remains ARCHIVED — the failed transaction rolled back.
        const after = await prisma.orgMembershipProcess.findUnique({ where: { id: p1.id } });
        expect(after?.status).toBe('ARCHIVED');
    });

    it('refuses to unarchive when no pre-archive status was captured (409 wrong_phase)', async () => {
        const { processId } = await makeProcess('NoPreImage', 'PENDING_PAYMENT');
        // Hand-set to ARCHIVED without going through archiveApplication — archivedFromStatus stays null.
        await prisma.orgMembershipProcess.update({ where: { id: processId }, data: { status: 'ARCHIVED' } });
        asBoard(boardId);
        const res = await UNARCHIVE(unarchiveReq({ processId }) as never);
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('wrong_phase');
    });

    it('GET ?archived=1 returns only ARCHIVED rows; default GET excludes them', async () => {
        const { processId: liveId } = await makeProcess('LiveForArchivedList', 'PENDING_PAYMENT');
        const { processId: archivedId } = await makeProcess('ArchivedForList', 'PENDING_PAYMENT');
        asBoard(boardId);
        await ARCHIVE(req({ processId: archivedId }) as never);

        const defaultRes = await ADMIN_LIST(listReq() as never);
        const defaultIds = (await defaultRes.json()).processes.map((p: { id: number }) => p.id);
        expect(defaultIds).toContain(liveId);
        expect(defaultIds).not.toContain(archivedId);

        const archivedRes = await ADMIN_LIST(archivedListReq() as never);
        const archivedBody = await archivedRes.json();
        expect(archivedBody.processes.map((p: { id: number }) => p.id)).toContain(archivedId);
        expect(archivedBody.processes.every((p: { status: string }) => p.status === 'ARCHIVED')).toBe(true);
    });

    // --- record refund (lib; the route lands with its registry entry) ---

    it('record refund: PENDING_BG_CLEARANCE → PENDING_PAYMENT, clears paidAt, keeps the order id and the check', async () => {
        const { processId } = await makeProcess('RefundClearance', 'PENDING_BG_CLEARANCE', { paidAt: new Date() });
        await prisma.orgMembershipProcess.update({ where: { id: processId }, data: { shopifyOrderId: 'ord-1', bgConsentAt: new Date() } });

        expect(await recordRefund(processId, boardId, 'Refunded in Shopify')).toEqual({ status: 'PENDING_PAYMENT' });
        const after = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect({ status: after?.status, paidAt: after?.paidAt, order: after?.shopifyOrderId, consent: !!after?.bgConsentAt })
            .toEqual({ status: 'PENDING_PAYMENT', paidAt: null, order: 'ord-1', consent: true });
        const audit = await prisma.auditLog.findFirst({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: processId }, orderBy: { id: 'desc' } });
        expect(audit?.newData).toMatchObject({ refundRecorded: true, reason: 'Refunded in Shopify' });

        // Now unpaid, so the board can close it.
        asBoard(boardId);
        expect((await ARCHIVE(req({ processId }) as never)).status).toBe(200);
    });

    it('record refund: a paid BLOCKED application loses paidAt but stays BLOCKED', async () => {
        const { processId } = await makeProcess('RefundBlocked', 'BLOCKED', { paidAt: new Date() });
        expect(await recordRefund(processId, boardId, 'Refunded')).toEqual({ status: 'BLOCKED' });
        const after = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect({ status: after?.status, paidAt: after?.paidAt }).toEqual({ status: 'BLOCKED', paidAt: null });
    });

    it('record refund refuses unpaid, ACTIVE, and own-household applications', async () => {
        const unpaid = await makeProcess('RefundUnpaid', 'PENDING_BG_CLEARANCE');
        await expect(recordRefund(unpaid.processId, boardId, 'x')).rejects.toMatchObject({ code: 'wrong_phase' });

        const active = await makeProcess('RefundActive', 'ACTIVE', { paidAt: new Date() });
        await expect(recordRefund(active.processId, boardId, 'x')).rejects.toMatchObject({ code: 'wrong_phase' });

        const own = await makeProcess('RefundOwn', 'PENDING_BG_CLEARANCE', { paidAt: new Date() });
        const selfBoard = await prisma.person.create({ data: { name: 'self board', isBoardMember: true, householdId: own.householdId } });
        await expect(recordRefund(own.processId, selfBoard.id, 'x')).rejects.toMatchObject({ code: 'same_household_applicant' });
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: own.processId } }))?.paidAt).not.toBeNull();
    });
});
