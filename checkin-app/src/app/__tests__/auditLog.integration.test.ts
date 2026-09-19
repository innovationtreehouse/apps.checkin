/**
 * @jest-environment node
 *
 * Node, not jsdom: the merge route's graph reaches @aws-sdk/client-s3, and jsdom
 * resolves the SDK's `browser` export condition to an ESM build jest cannot
 * transform. Every SDK-touching suite here runs on node.
 *
 * Integration Test for Audit Logs
 * Ensures that various actions across the system correctly generate an AuditLog.
 * Using Next.js testing practices with local Prisma DB.
 */

import { POST as createProgram } from '@/app/api/programs/route';
import { normalizeAuditData } from '@/lib/auditPayload';
import { PATCH as updateProgramSettings } from '@/app/api/programs/[id]/route';
import { POST as enrollParticipant } from '@/app/api/programs/[id]/participants/route';
import { PATCH as editAttendance } from '@/app/api/events/[id]/route';
import { PUT as editParticipant } from '@/app/api/membership-ops/participants/[id]/route';
import { POST as reassignHousehold } from '@/app/api/membership-ops/participants/[id]/household/route';
import { PATCH as updateRoles } from '@/app/api/roles/route';
import { POST as mergeParticipants } from '@/app/api/membership-ops/participants/merge/route';
import { PATCH as updateHousehold } from '@/app/api/membership-ops/households/[id]/route';
import { PATCH as updateVisit } from '@/app/api/facility/visits/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));
// Mock Notifications to avoid external calls
jest.mock('@/lib/notifications', () => ({
    sendNotification: jest.fn()
}));

describe('AuditLog Integration Tests', () => {
    let testAdminId: number;
    let testParticipantId: number;
    let testProgramId: number;
    let testEventId: number;
    let testVisitId: number;

    // TAG-scoped throwaway entities for the admin-writer cases below, tracked by
    // id so afterAll cleans exactly what these tests made (no unfiltered deleteMany).
    const TAG = 'audit-writers';
    const createdParticipantIds: number[] = [];
    const createdHouseholdIds: number[] = [];
    const createdVisitIds: number[] = [];

    async function makeParticipant(suffix: string) {
        const p = await prisma.person.create({
            // 'audit-test' substring also matches the beforeAll backstop sweep.
            data: { email: `${TAG}-${suffix}-audit-test@example.com`, name: `${TAG} ${suffix}`, household: { create: { name: "Test HH" } } },
            select: { id: true, householdId: true },
        });
        createdParticipantIds.push(p.id);
        if (p.householdId) createdHouseholdIds.push(p.householdId);
        return p;
    }

    beforeAll(async () => {
        // Clean up any leaked state from previous runs
        await prisma.auditLog.deleteMany({});
        await prisma.visit.deleteMany({});
        await prisma.rSVP.deleteMany({});
        await prisma.programParticipant.deleteMany({});
        await prisma.programVolunteer.deleteMany({});
        await prisma.event.deleteMany({});
        await prisma.programInstance.deleteMany({});
        await prisma.program.deleteMany({});
        await prisma.person.deleteMany({
            where: { email: { contains: 'audit-test' } }
        });

        // Setup mock database records
        const admin = await prisma.person.create({
            data: { email: 'admin-audit-test@example.com', name: 'Admin Test', isSysadmin: true, isDeclaredAdult: true, household: { create: { name: "Test HH" } } }
        });
        testAdminId = admin.id;

        const participant = await prisma.person.create({
            data: { email: 'participant-audit-test@example.com', name: 'Participant Test', household: { create: { name: "Test HH" } } }
        });
        testParticipantId = participant.id;
    });

    afterAll(async () => {
        // TAG-scoped cleanup for the admin-writer cases (FK-safe order). Audit rows
        // they wrote all carry actorId=testAdminId and are swept by the block below.
        if (createdVisitIds.length > 0) {
            await prisma.visit.deleteMany({ where: { id: { in: createdVisitIds } } });
        }
        if (createdParticipantIds.length > 0) {
            // A merge case here archives to PersonMerge, whose toId is RESTRICT — the
            // archive row has to go before the survivor it names (#1456 2b).
            await prisma.personMerge.deleteMany({ where: { OR: [{ toId: { in: createdParticipantIds } }, { fromId: { in: createdParticipantIds } }] } });
            await prisma.person.deleteMany({ where: { id: { in: createdParticipantIds } } });
        }
        if (createdHouseholdIds.length > 0) {
            await prisma.household.deleteMany({ where: { id: { in: createdHouseholdIds } } });
        }

        // Clean up
        if (testParticipantId !== undefined) {
            await prisma.visit.deleteMany({ where: { personId: testParticipantId } });
            await prisma.rSVP.deleteMany({ where: { personId: testParticipantId } });
        }

        if (testProgramId !== undefined) {
            await prisma.event.deleteMany({ where: { programId: testProgramId } });
            await prisma.programParticipant.deleteMany({ where: { programId: testProgramId } });
            await prisma.programInstance.deleteMany({ where: { programId: testProgramId } });
            await prisma.program.deleteMany({ where: { id: testProgramId } });
        }

        const actorIds = [testAdminId, testParticipantId].filter(id => id !== undefined);
        if (actorIds.length > 0) {
            await prisma.auditLog.deleteMany({
                where: { actorId: { in: actorIds } }
            });

            // RESTRICT: delete participants before their households.
            const householdIds = (await prisma.person.findMany({
                where: { id: { in: actorIds } },
                select: { householdId: true }
            })).map(p => p.householdId);

            await prisma.person.deleteMany({
                where: { id: { in: actorIds } }
            });
            await prisma.household.deleteMany({
                where: { id: { in: householdIds } }
            });
        }
    });

    beforeEach(() => {
        // Reset mocks and default to admin session
        (getServerSession as jest.Mock).mockResolvedValue({
            user: { id: testAdminId, isSysadmin: true }
        });
    });

    it('should generate an AuditLog when a Program is created', async () => {
        const req = new Request('http://localhost:4000/api/programs', {
            method: 'POST',
            body: JSON.stringify({
                name: 'Audit Test Program',
                enrollmentStatus: 'OPEN',
                startAt: '2026-01-01',
                endAt: '2026-12-31',
                leadMentorId: testAdminId,
                maxParticipants: 50
            })
        });

        const res = await createProgram(req as unknown as import("next/server").NextRequest);
        expect(res.status).toBe(200);

        const responseData = await res.json();
        testProgramId = responseData.program.id;

        // Verify Audit Log
        const log = await prisma.auditLog.findFirst({
            where: {
                actorId: testAdminId,
                action: 'CREATE',
                tableName: 'Program',
                affectedEntityId: testProgramId
            },
            orderBy: { timestamp: 'desc' }
        });

        expect(log).toBeDefined();
        expect(log?.newData).toBeDefined();
    });

    it('should generate an AuditLog when Program Settings are updated', async () => {
        const req = new Request(`http://localhost:4000/api/programs/${testProgramId}`, {
            method: 'PATCH',
            body: JSON.stringify({ leadMentorNotificationSettings: { notifyRsvp: true } })
        });

        const res = await updateProgramSettings(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: testProgramId.toString() }) });
        expect(res.status).toBe(200);

        // Verify Audit Log
        const log = await prisma.auditLog.findFirst({
            where: {
                actorId: testAdminId,
                action: 'EDIT',
                tableName: 'Program',
                affectedEntityId: testProgramId
            },
            orderBy: { timestamp: 'desc' }
        });

        expect(log).toBeDefined();
        const newData = log?.newData as { leadMentorNotificationSettings: { notifyRsvp: boolean } };
        expect(newData.leadMentorNotificationSettings.notifyRsvp).toBe(true);
    });

    it('should generate an AuditLog when an Admin enrolls a participant', async () => {
        const req = new Request(`http://localhost:4000/api/programs/${testProgramId}/participants`, {
            method: 'POST',
            body: JSON.stringify({ participantId: testParticipantId, override: true })
        });

        const res = await enrollParticipant(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: testProgramId.toString() }) });
        const data = await res.json();
        if (res.status !== 200) console.error("Enrollment error:", data);
        expect(res.status).toBe(200);

        // Verify Audit Log
        const log = await prisma.auditLog.findFirst({
            where: {
                actorId: testAdminId,
                action: 'CREATE',
                tableName: 'ProgramParticipant',
                affectedEntityId: testParticipantId,
                secondaryAffectedEntity: testProgramId
            },
            orderBy: { timestamp: 'desc' }
        });

        expect(log).toBeDefined();
    });

    it('should generate an AuditLog when a lead corrects attendance', async () => {
        const arrivedAt = new Date(Date.now() - 100000);
        const departedAt = new Date(Date.now() - 50000);

        const event = await prisma.event.create({
            data: { programId: testProgramId, name: 'Audit Test Event', startAt: arrivedAt, endAt: departedAt }
        });
        testEventId = event.id;

        const visit = await prisma.visit.create({
            data: { personId: testParticipantId, arrivedAt, departedAt, associatedEventId: event.id }
        });
        testVisitId = visit.id;

        const req = new Request(`http://localhost:4000/api/events/${testEventId}`, {
            method: 'PATCH',
            body: JSON.stringify({
                action: 'manualEditAttendance',
                participantId: testParticipantId,
                status: 'Present',
                arrivedAt: arrivedAt.toISOString(),
                departedAt: departedAt.toISOString()
            })
        });

        const res = await editAttendance(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: testEventId.toString() }) });
        expect(res.status).toBe(200);

        // One row per corrected Visit, keyed by the Visit PK.
        const log = await prisma.auditLog.findFirst({
            where: {
                actorId: testAdminId,
                action: 'EDIT',
                tableName: 'Visit',
                affectedEntityId: testVisitId,
                // The SUBJECT, not the event — a Visit audit row names whose
                // visit it is, so actorId !== this marks acting-for-another.
                secondaryAffectedEntity: testParticipantId
            },
            orderBy: { timestamp: 'desc' }
        });

        expect(log).toBeDefined();
        // newData is now a raw JSON object (legacy rows may still be strings).
        const newData = normalizeAuditData(log?.newData) as Record<string, unknown>;
        expect(newData.type).toBe('lead_attendance_correction');
        // The update branch leaves arrivedVia alone, so the audit must not claim
        // it changed; the departure the lead typed IS staff-asserted.
        expect(newData).not.toHaveProperty('arrivedVia');
        expect(newData.departedVia).toBe('LEAD_MARKED');
    });

    it('should generate an AuditLog when an Admin edits participant PII', async () => {
        await prisma.auditLog.deleteMany({ where: { tableName: 'Person' } });

        const req = new Request(`http://localhost:4000/api/membership-ops/participants/${testParticipantId}`, {
            method: 'PUT',
            body: JSON.stringify({ name: 'Edited Audit Name', email: 'edited-audit-test@example.com' })
        });

        const res = await editParticipant(req as never, { params: Promise.resolve({ id: testParticipantId.toString() }) });
        expect(res.status).toBe(200);

        const logs = await prisma.auditLog.findMany({
            where: { tableName: 'Person', affectedEntityId: testParticipantId }
        });
        expect(logs).toHaveLength(1);
        expect(logs[0].action).toBe('EDIT');
        expect(logs[0].actorId).toBe(testAdminId);
        const newData = logs[0].newData as { name: string };
        expect(newData.name).toBe('Edited Audit Name');
    });

    it('should generate an AuditLog when an Admin reassigns a participant household', async () => {
        await prisma.auditLog.deleteMany({ where: { tableName: 'Person' } });

        const newHousehold = await prisma.household.create({ data: { name: 'Audit Target Household' } });

        const req = new Request(`http://localhost:4000/api/membership-ops/participants/${testParticipantId}/household`, {
            method: 'POST',
            body: JSON.stringify({ householdId: newHousehold.id })
        });

        const res = await reassignHousehold(req as never, { params: Promise.resolve({ id: testParticipantId.toString() }) });
        expect(res.status).toBe(200);

        const logs = await prisma.auditLog.findMany({
            where: { tableName: 'Person', affectedEntityId: testParticipantId }
        });
        expect(logs).toHaveLength(1);
        expect(logs[0].action).toBe('EDIT');
        const newData = logs[0].newData as { householdId: number };
        expect(newData.householdId).toBe(newHousehold.id);
    });

    // --- Additional high-stakes privilege / write coverage ---
    // Each asserts the route persists EXACTLY ONE AuditLog row with the right
    // actor (acting session user), action, table, affected entity, and newData.
    // Scoped by affectedEntityId on fresh TAG entities so they don't collide with
    // the Participant-table cleanup the two cases above perform.

    it('role grant (PATCH /admin/roles) writes one AuditLog with the privilege change', async () => {
        const target = await makeParticipant('role-target');

        const req = new Request('http://localhost:4000/api/roles', {
            method: 'PATCH',
            body: JSON.stringify({ targetUserId: target.id, isKeyholder: true }),
        });

        const res = await updateRoles(req as never);
        expect(res.status).toBe(200);

        const logs = await prisma.auditLog.findMany({
            where: { action: 'EDIT', tableName: 'PersonRole', affectedEntityId: target.id },
        });
        expect(logs).toHaveLength(1);
        expect(logs[0].actorId).toBe(testAdminId);
        expect((logs[0].newData as { isKeyholder?: boolean }).isKeyholder).toBe(true);
    });

    it('participant merge (POST /admin/participants/merge) writes one AuditLog tombstoning the merged id', async () => {
        const keep = await makeParticipant('merge-keep');
        const merge = await makeParticipant('merge-from');

        const req = new Request('http://localhost:4000/api/membership-ops/participants/merge', {
            method: 'POST',
            // name differs and both carry a login identity (email) — real conflicts.
            // Resolve name + the identity unit to "keep" so this audit-log assertion
            // doesn't depend on the field-picker's validation (its own suite covers that).
            body: JSON.stringify({ keepId: keep.id, mergeId: merge.id, fieldChoices: { name: 'keep', identity: 'keep' } }),
        });

        const res = await mergeParticipants(req as never);
        const data = await res.json();
        if (res.status !== 200) console.error('Merge error:', data);
        expect(res.status).toBe(200);

        const logs = await prisma.auditLog.findMany({
            where: {
                action: 'DELETE',
                tableName: 'Person',
                affectedEntityId: keep.id,
                secondaryAffectedEntity: merge.id,
            },
        });
        expect(logs).toHaveLength(1);
        expect(logs[0].actorId).toBe(testAdminId);
        expect((logs[0].newData as { keepId?: number }).keepId).toBe(keep.id);
        expect((logs[0].oldData as { id?: number }).id).toBe(merge.id);
    });

    it('household edit (PATCH /admin/households/[id]) writes one AuditLog with before/after', async () => {
        const household = await prisma.household.create({ data: { name: `${TAG} household orig` }, select: { id: true } });
        createdHouseholdIds.push(household.id);

        const req = new Request(`http://localhost:4000/api/membership-ops/households/${household.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ name: 'Audit Edited Household' }),
        });

        const res = await updateHousehold(req as never, { params: Promise.resolve({ id: household.id.toString() }) });
        expect(res.status).toBe(200);

        const logs = await prisma.auditLog.findMany({
            where: { action: 'EDIT', tableName: 'Household', affectedEntityId: household.id },
        });
        expect(logs).toHaveLength(1);
        expect(logs[0].actorId).toBe(testAdminId);
        // Route stringifies oldData/newData.
        expect((normalizeAuditData(logs[0].newData) as Record<string, unknown>).name).toBe('Audit Edited Household');
        expect((normalizeAuditData(logs[0].oldData) as Record<string, unknown>).name).toBe(`${TAG} household orig`);
    });

    it('visit edit (PATCH /admin/visits) writes one AuditLog snapshotting the visit', async () => {
        const owner = await makeParticipant('visit-owner');
        const visit = await prisma.visit.create({
            data: { personId: owner.id, arrivedAt: new Date(), departedAt: new Date() },
            select: { id: true },
        });
        createdVisitIds.push(visit.id);

        const newArrived = new Date('2020-01-01T10:00:00.000Z');
        const newDeparted = new Date('2020-01-01T12:00:00.000Z');
        const req = new Request('http://localhost:4000/api/facility/visits', {
            method: 'PATCH',
            body: JSON.stringify({ visitId: visit.id, arrivedAt: newArrived.toISOString(), departedAt: newDeparted.toISOString() }),
        });

        const res = await updateVisit(req as never);
        expect(res.status).toBe(200);

        const logs = await prisma.auditLog.findMany({
            where: { action: 'EDIT', tableName: 'Visit', affectedEntityId: visit.id },
        });
        expect(logs).toHaveLength(1);
        expect(logs[0].actorId).toBe(testAdminId);
        expect((logs[0].newData as { id?: number }).id).toBe(visit.id);
        // oldData comes from the in-lock re-read (`previous`), not the
        // pre-lock `existing` snapshot — same row here, but pins the swap.
        expect((logs[0].oldData as { id?: number }).id).toBe(visit.id);
    });
});
