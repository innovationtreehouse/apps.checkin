/**
 * @jest-environment node
 */
/**
 * Integration tests for POST /api/my-programs/conflicts/resolve.
 *
 * Covers: 400 (missing/non-integer visitId), 401 (no session), 404 (visit not
 * found), 403 (caller neither leads the visit's program nor is a global
 * admin), 409 (visit has no genuine overlap — refuse to delete an isolated,
 * legitimate visit), and the 200 success path for both a leading mentor and a
 * global admin — asserting the Visit row is gone and an audit trail (action
 * DELETE, tableName Visit, oldData snapshot) was written.
 */

import { POST } from '@/app/api/my-programs/conflicts/resolve/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

const TAG = 'conflicts-resolve-test';

describe('My-programs conflicts resolve API', () => {
    let leadId: number;
    let otherLeadId: number;
    let adminId: number;
    let participantId: number;
    let householdId: number;
    let programId: number;
    let eventId: number;

    const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

    beforeAll(async () => {
        const lead = await prisma.person.create({
            data: { email: `lead-${TAG}@example.com`, name: 'Lead', household: { create: { name: "Test HH" } } },
        });
        leadId = lead.id;
        householdId = lead.householdId;

        const otherLead = await prisma.person.create({
            data: { email: `other-lead-${TAG}@example.com`, name: 'Other Lead', householdId },
        });
        otherLeadId = otherLead.id;

        const admin = await prisma.person.create({
            data: { email: `admin-${TAG}@example.com`, name: 'Admin', isSysadmin: true, householdId },
        });
        adminId = admin.id;

        const participant = await prisma.person.create({
            data: { email: `participant-${TAG}@example.com`, name: 'Participant', householdId },
        });
        participantId = participant.id;

        const program = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Prog ${TAG}`, leadMentorId: leadId } });
        programId = program.id;
        const event = await prisma.event.create({
            data: { programId, name: `Event ${TAG}`, startAt: hoursAgo(5), endAt: hoursAgo(2) },
        });
        eventId = event.id;
    });

    afterAll(async () => {
        await prisma.auditLog.deleteMany({ where: { actorId: { in: [leadId, adminId] } } });
        await prisma.visit.deleteMany({ where: { personId: participantId } });
        await prisma.event.deleteMany({ where: { id: eventId } });
        await prisma.program.deleteMany({ where: { id: programId } });
        await prisma.person.deleteMany({ where: { id: { in: [leadId, otherLeadId, adminId, participantId] } } });
        await prisma.household.deleteMany({ where: { id: householdId } });
    });

    const callAs = async (user: object | null, body: unknown) => {
        (getServerSession as jest.Mock).mockResolvedValue(user === null ? null : { user });
        const req = new Request('http://localhost:4000/api/my-programs/conflicts/resolve', {
            method: 'POST',
            body: JSON.stringify(body),
        });
        return POST(req as unknown as import('next/server').NextRequest);
    };

    it('returns 401 without a session', async () => {
        const res = await callAs(null, { visitId: 1 });
        expect(res.status).toBe(401);
    });

    it('returns 400 for a missing/non-integer visitId', async () => {
        const res1 = await callAs({ id: leadId }, {});
        expect(res1.status).toBe(400);
        const res2 = await callAs({ id: leadId }, { visitId: 'abc' });
        expect(res2.status).toBe(400);
    });

    it('returns 404 when the visit does not exist', async () => {
        const res = await callAs({ id: leadId }, { visitId: 999_999_999 });
        expect(res.status).toBe(404);
    });

    it('returns 409 when the visit has no genuine overlap (refuses to delete an isolated visit)', async () => {
        const isolated = await prisma.visit.create({
            data: { personId: participantId, arrivedAt: hoursAgo(5), departedAt: hoursAgo(4), associatedEventId: eventId },
        });
        try {
            const res = await callAs({ id: leadId }, { visitId: isolated.id });
            expect(res.status).toBe(409);
        } finally {
            await prisma.visit.deleteMany({ where: { id: isolated.id } });
        }
    });

    it('returns 403 for a caller who neither leads the program nor is a global admin', async () => {
        const [anchor, sibling] = await Promise.all([
            prisma.visit.create({ data: { personId: participantId, arrivedAt: hoursAgo(5), departedAt: hoursAgo(2), associatedEventId: eventId } }),
            prisma.visit.create({ data: { personId: participantId, arrivedAt: hoursAgo(4), departedAt: hoursAgo(1) } }),
        ]);
        try {
            const res = await callAs({ id: otherLeadId }, { visitId: anchor.id });
            expect(res.status).toBe(403);
        } finally {
            await prisma.visit.deleteMany({ where: { id: { in: [anchor.id, sibling.id] } } });
        }
    });

    it('lets the leading mentor delete an overlapping visit and writes an audit trail', async () => {
        const anchor = await prisma.visit.create({
            data: { personId: participantId, arrivedAt: hoursAgo(5), departedAt: hoursAgo(2), arrivedVia: 'LEAD_MARKED', associatedEventId: eventId },
        });
        const sibling = await prisma.visit.create({
            data: { personId: participantId, arrivedAt: hoursAgo(4), departedAt: hoursAgo(1), arrivedVia: 'SCANNER' },
        });
        try {
            const res = await callAs({ id: leadId }, { visitId: anchor.id });
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data).toEqual({ success: true, deletedVisitId: anchor.id });

            // Tombstoned, not removed: the row survives so the resolution stays
            // reviewable and reversible, and drops out of every LIVE_VISIT read.
            const gone = await prisma.visit.findUnique({ where: { id: anchor.id } });
            expect(gone?.deletedAt).toBeInstanceOf(Date);
            expect(gone?.deletedById).toBe(leadId);
            const survives = await prisma.visit.findUnique({ where: { id: sibling.id } });
            expect(survives?.deletedAt).toBeNull();

            const audit = await prisma.auditLog.findFirst({
                where: { actorId: leadId, tableName: 'Visit', affectedEntityId: anchor.id, action: 'DELETE' },
            });
            expect(audit).toBeDefined();
            // The subject, not the event; the event stays in oldData.
            expect(audit?.secondaryAffectedEntity).toBe(participantId);
            expect((audit?.oldData as { personId: number })?.personId).toBe(participantId);

            // 3h span, LEAD_MARKED arrival (weight 2) beats the untagged
            // departure (weight 1) -> weight 2; proxy delete (lead != subject)
            // doubles it: 180 * 2 * 2 = 720. Always flagged (delete floor).
            expect((audit?.newData as { significance?: { score: number; flagged: boolean } })?.significance)
                .toEqual({ score: 720, flagged: true });
        } finally {
            await prisma.visit.deleteMany({ where: { id: { in: [anchor.id, sibling.id] } } });
        }
    });

    it('lets a global admin delete an overlapping visit for a program they do not lead', async () => {
        const anchor = await prisma.visit.create({
            data: { personId: participantId, arrivedAt: hoursAgo(5), departedAt: hoursAgo(2), associatedEventId: eventId },
        });
        const sibling = await prisma.visit.create({
            data: { personId: participantId, arrivedAt: hoursAgo(4), departedAt: hoursAgo(1) },
        });
        try {
            const res = await callAs({ id: adminId, isSysadmin: true }, { visitId: anchor.id });
            expect(res.status).toBe(200);
            const gone = await prisma.visit.findUnique({ where: { id: anchor.id } });
            expect(gone?.deletedAt).toBeInstanceOf(Date);
        } finally {
            await prisma.visit.deleteMany({ where: { id: { in: [anchor.id, sibling.id] } } });
        }
    });
});
