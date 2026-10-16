/**
 * @jest-environment node
 *
 * Integration tests for DELETE /api/membership-ops/bg-attestations/[id] —
 * the sysadmin-only cleanup path for a BackgroundCheckAttestation the
 * participant-merge route refuses to carry forward (#1456 Decision 3).
 * Real Postgres, INTEGRATION_DB=1.
 *
 * 401/403 (incl. board-only) live in authzRoleRejection.integration.test.ts,
 * the shared table for role-gated routes. This file covers the route's own
 * behavior: 400 without a reason, 404 on a missing/unknown id, success
 * (row gone + an audit row carrying the reason and the deleted row's
 * fields), and the end-to-end case this endpoint exists for — unblocking a
 * merge the collision check refused.
 */
import { DELETE } from '../route';
import { POST as MERGE_POST } from '@/app/api/membership-ops/participants/merge/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { expectAuditRow, auditJson } from '@/test-helpers/expectAuditRow';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));

const TAG = 'bg-attestation-remove-test';

function asSysadmin(id: number) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isSysadmin: true } });
}

function delReq(id: number | string, body?: unknown) {
    return new Request(`http://localhost/api/membership-ops/bg-attestations/${id}`, {
        method: 'DELETE',
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as never;
}
function ctx(id: number | string) {
    return { params: Promise.resolve({ id: String(id) }) } as never;
}

describe('DELETE /api/membership-ops/bg-attestations/[id]', () => {
    let householdId: number;
    let reviewerId: number;
    let sysadminId: number;
    let processId: number;
    let attestationId: number;
    // Ids an individual test creates beyond the base fixture, swept generically
    // in afterEach (RESTRICT-FK children before their Person rows).
    let extraPersonIds: number[];
    let extraHouseholdIds: number[];

    beforeEach(async () => {
        extraPersonIds = [];
        extraHouseholdIds = [];

        const hh = await prisma.household.create({ data: { name: `HH ${TAG}` } });
        householdId = hh.id;
        reviewerId = (await prisma.person.create({ data: { name: `Reviewer ${TAG}`, householdId } })).id;
        sysadminId = (await prisma.person.create({ data: { name: `Sysadmin ${TAG}`, isSysadmin: true, householdId } })).id;
        processId = (await prisma.orgMembershipProcess.create({ data: { kind: 'PERSON_BG', status: 'PENDING_BG_REVIEW' } })).id;
        attestationId = (await prisma.backgroundCheckAttestation.create({
            data: { processId, reviewerId, result: 'APPROVE', note: 'looked fine' },
        })).id;
        asSysadmin(sysadminId);
    });

    afterEach(async () => {
        const personIds = [reviewerId, sysadminId, ...extraPersonIds];
        await prisma.backgroundCheckAttestation.deleteMany({ where: { OR: [{ processId }, { reviewerId: { in: personIds } }] } });
        await prisma.auditLog.deleteMany({ where: { OR: [{ affectedEntityId: attestationId, tableName: 'BackgroundCheckAttestation' }, { actorId: { in: personIds } }] } });
        await prisma.orgMembershipProcess.deleteMany({ where: { id: processId } });
        // A case here runs a real merge, which now archives it. PersonMerge.toId is
        // RESTRICT, so the archive row outranks its survivor (#1456 2b).
        await prisma.personMerge.deleteMany({ where: { OR: [{ toId: { in: personIds } }, { fromId: { in: personIds } }] } });
        await prisma.person.deleteMany({ where: { id: { in: personIds } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: [householdId, ...extraHouseholdIds] } } });
        await prisma.household.deleteMany({ where: { id: { in: [householdId, ...extraHouseholdIds] } } });
    });

    it('400s without a reason, and leaves the row in place', async () => {
        const res = await DELETE(delReq(attestationId, {}), ctx(attestationId));
        expect(res.status).toBe(400);
        expect(await prisma.backgroundCheckAttestation.findUnique({ where: { id: attestationId } })).not.toBeNull();
    });

    it('400s on a non-numeric id', async () => {
        const res = await DELETE(delReq('abc', { reason: 'typo id' }), ctx('abc'));
        expect(res.status).toBe(400);
    });

    it('404s for an id with no matching row', async () => {
        const res = await DELETE(delReq(attestationId + 999_000, { reason: 'not real' }), ctx(attestationId + 999_000));
        expect(res.status).toBe(404);
    });

    it('deletes the row and writes an audit row carrying the reason', async () => {
        const res = await DELETE(delReq(attestationId, { reason: 'duplicate identity — reviewed under two accounts' }), ctx(attestationId));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({});

        expect(await prisma.backgroundCheckAttestation.findUnique({ where: { id: attestationId } })).toBeNull();

        const audit = await expectAuditRow(prisma, {
            action: 'DELETE',
            tableName: 'BackgroundCheckAttestation',
            affectedEntityId: attestationId,
            secondaryAffectedEntity: processId,
        });
        expect(audit.actorId).toBe(sysadminId);
        expect(auditJson(audit.newData)).toEqual({ reason: 'duplicate identity — reviewed under two accounts' });
        expect(auditJson(audit.oldData)).toMatchObject({ processId, reviewerId, result: 'APPROVE', note: 'looked fine' });
    });

    // The scenario this endpoint exists for (#1456 Decision 3): the merge route
    // refuses when both merge subjects attested the same background check, and
    // deleting one of the two duplicate rows is what turns the refusal into a
    // mergeable state.
    it('unblocks a merge the bgAttestation collision check refused', async () => {
        const otherReviewerId = (await prisma.person.create({ data: { name: `Other Reviewer ${TAG}`, householdId } })).id;
        const actorHh = (await prisma.household.create({ data: { name: `Actor HH ${TAG}` } })).id;
        const actorId = (await prisma.person.create({ data: { name: `Merge Actor ${TAG}`, isBoardMember: true, householdId: actorHh } })).id;
        extraPersonIds.push(otherReviewerId, actorId);
        extraHouseholdIds.push(actorHh);

        // Both hold an attestation on the SAME process — the collision.
        const dupeAttestationId = (await prisma.backgroundCheckAttestation.create({
            data: { processId, reviewerId: otherReviewerId, result: 'APPROVE' },
        })).id;

        const mergeReq = () => new Request('http://localhost/api/membership-ops/participants/merge', {
            method: 'POST',
            body: JSON.stringify({ keepId: reviewerId, mergeId: otherReviewerId, fieldChoices: { name: 'keep' } }),
        }) as never;

        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: actorId, isBoardMember: true } });
        const refused = await MERGE_POST(mergeReq());
        expect(refused.status).toBe(409);
        const refusedBody = await refused.json();
        expect((refusedBody.collisions as { type: string }[]).map((c) => c.type)).toContain('bgAttestation');

        asSysadmin(sysadminId);
        const cleanup = await DELETE(delReq(dupeAttestationId, { reason: 'duplicate identity, confirmed by board' }), ctx(dupeAttestationId));
        expect(cleanup.status).toBe(200);

        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: actorId, isBoardMember: true } });
        const retried = await MERGE_POST(mergeReq());
        expect(retried.status).toBe(200);
    });
});
