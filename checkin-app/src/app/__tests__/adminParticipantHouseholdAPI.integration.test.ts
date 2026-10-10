/**
 * @jest-environment node
 */
import { POST } from '@/app/api/membership-ops/participants/[id]/household/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { expectAuditRow, auditJson } from '@/test-helpers/expectAuditRow';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

describe('Admin Participant Household API Integration Tests', () => {
    let testAdminId: number;
    let testUserId: number;
    let testParticipantId: number;
    let testHouseholdId: number;
    let testAdminHouseholdId: number;

    beforeAll(async () => {
        // Clean up any leaked state
        await prisma.orgMembership.deleteMany({});
        await prisma.person.deleteMany({
            where: { email: { contains: 'household-api-test' } }
        });
        await prisma.household.deleteMany({
            where: { name: { contains: 'Household API Test' } }
        });

        const admin = await prisma.person.create({
            data: { email: 'admin-household-api-test@example.com', name: 'Admin Test', isSysadmin: true, household: { create: { name: "Test HH" } } }
        });
        testAdminId = admin.id;
        testAdminHouseholdId = admin.householdId;

        const user = await prisma.person.create({
            data: { email: 'user-household-api-test@example.com', name: 'User Test', household: { create: { name: "Test HH" } } }
        });
        testUserId = user.id;

        const household = await prisma.household.create({
            data: { name: 'Household API Test 1' }
        });
        testHouseholdId = household.id;
    });

    afterAll(async () => {
        await prisma.orgMembership.deleteMany({});
        await prisma.person.deleteMany({
            where: { email: { contains: 'household-api-test' } }
        });
        await prisma.household.deleteMany({
            where: { name: { contains: 'Household API Test' } }
        });
    });

    beforeEach(async () => {
        const participant = await prisma.person.create({
            data: { email: 'subject-household-api-test@example.com', name: 'Subject Test', household: { create: { name: "Test HH" } } }
        });
        testParticipantId = participant.id;
    });

    afterEach(async () => {
        await prisma.orgMembership.deleteMany({});
        await prisma.person.deleteMany({
            where: { name: 'Subject Test' }
        });
        // createNew names the household after the subject.
        await prisma.household.deleteMany({
            where: { name: "Subject Test's Household" }
        });
    });

    describe("POST /api/membership-ops/participants/[id]/household — actor's own household", () => {
        function moveReq(personId: number, body: Record<string, unknown>) {
            return new Request(`http://localhost:4000/api/membership-ops/participants/${personId}/household`, {
                method: 'POST',
                body: JSON.stringify(body),
            }) as unknown as import('next/server').NextRequest;
        }

        beforeEach(() => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });
        });

        it("refuses moving a member of the actor's household out -> 403, unchanged", async () => {
            const spouse = await prisma.person.update({ where: { id: testParticipantId }, data: { householdId: testAdminHouseholdId } });
            const res = await POST(moveReq(spouse.id, { createNew: true }), { params: Promise.resolve({ id: String(spouse.id) }) });
            expect(res.status).toBe(403);
            const after = await prisma.person.findUnique({ where: { id: spouse.id }, select: { householdId: true } });
            expect(after?.householdId).toBe(testAdminHouseholdId);
        });

        it("refuses moving someone into the actor's household -> 403, unchanged", async () => {
            const before = await prisma.person.findUniqueOrThrow({ where: { id: testParticipantId }, select: { householdId: true } });
            const res = await POST(moveReq(testParticipantId, { householdId: testAdminHouseholdId }), { params: Promise.resolve({ id: String(testParticipantId) }) });
            expect(res.status).toBe(403);
            const after = await prisma.person.findUnique({ where: { id: testParticipantId }, select: { householdId: true } });
            expect(after?.householdId).toBe(before.householdId);
        });

        it('refuses moving yourself -> 403', async () => {
            const res = await POST(moveReq(testAdminId, { householdId: testHouseholdId }), { params: Promise.resolve({ id: String(testAdminId) }) });
            expect(res.status).toBe(403);
            const after = await prisma.person.findUnique({ where: { id: testAdminId }, select: { householdId: true } });
            expect(after?.householdId).toBe(testAdminHouseholdId);
        });
    });

    describe('POST /api/membership-ops/participants/[id]/household', () => {
        it('should return 403 Forbidden for non-admin users', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testUserId, isSysadmin: false, isBoardMember: false }
            });

            const req = new Request(`http://localhost:4000/api/membership-ops/participants/${testParticipantId}/household`, {
                method: 'POST',
                body: JSON.stringify({ householdId: testHouseholdId })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(testParticipantId) }) });
            expect(res.status).toBe(403);
        });

        it('should successfully add a participant to an existing household', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const subjectBefore = await prisma.person.findUnique({ where: { id: testParticipantId } });
            const priorHouseholdId = subjectBefore!.householdId;

            const req = new Request(`http://localhost:4000/api/membership-ops/participants/${testParticipantId}/household`, {
                method: 'POST',
                body: JSON.stringify({ householdId: testHouseholdId })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(testParticipantId) }) });
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.success).toBe(true);
            expect(data.participant.householdId).toBe(testHouseholdId);

            const updatedParticipant = await prisma.person.findUnique({ where: { id: testParticipantId } });
            expect(updatedParticipant?.householdId).toBe(testHouseholdId);

            // The move MUST be audited with the acting admin and the prior→new
            // household — the route's only record of who reassigned the person.
            const log = await expectAuditRow(prisma, { action: 'EDIT', tableName: 'Person', affectedEntityId: testParticipantId });
            expect(log.actorId).toBe(testAdminId);
            expect(auditJson(log.oldData).householdId).toBe(priorHouseholdId);
            expect(auditJson(log.newData).householdId).toBe(testHouseholdId);
        });

        it('clears the lead flag when a lead is moved to another household (a1 de-lead-on-transfer)', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            // Make the subject a lead of their OWN (beforeEach-created) household.
            await prisma.person.update({ where: { id: testParticipantId }, data: { isHouseholdLead: true } });

            const req = new Request(`http://localhost:4000/api/membership-ops/participants/${testParticipantId}/household`, {
                method: 'POST',
                body: JSON.stringify({ householdId: testHouseholdId })
            });
            const res = await POST(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(testParticipantId) }) });
            expect(res.status).toBe(200);

            const moved = await prisma.person.findUnique({ where: { id: testParticipantId } });
            expect(moved?.householdId).toBe(testHouseholdId);
            // Leadership does NOT travel on a move: isHouseholdLead means "lead of
            // their own household", and this is now a different household — they
            // must be re-promoted to lead it.
            expect(moved?.isHouseholdLead).toBe(false);
        });

        it('should successfully create a new household for the participant', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const req = new Request(`http://localhost:4000/api/membership-ops/participants/${testParticipantId}/household`, {
                method: 'POST',
                body: JSON.stringify({ createNew: true })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(testParticipantId) }) });
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.success).toBe(true);
            expect(data.participant.householdId).not.toBeNull();
            expect(data.participant.householdId).not.toBe(testHouseholdId);

            const newHouseholdId = data.participant.householdId;
            expect(data.participant.isHouseholdLead).toBe(true);

            // Sole lead of the household that was just created for them.
            const leads = await prisma.person.findMany({
                where: { householdId: newHouseholdId, isHouseholdLead: true },
                select: { id: true }
            });
            expect(leads.map(l => l.id)).toEqual([testParticipantId]);
        });

        it('moves the lead flag with a lead who is given a new household of their own', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const subjectBefore = await prisma.person.findUnique({ where: { id: testParticipantId } });
            const priorHouseholdId = subjectBefore!.householdId!;
            await prisma.person.update({ where: { id: testParticipantId }, data: { isHouseholdLead: true } });

            const req = new Request(`http://localhost:4000/api/membership-ops/participants/${testParticipantId}/household`, {
                method: 'POST',
                body: JSON.stringify({ createNew: true })
            });
            const res = await POST(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(testParticipantId) }) });
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.participant.householdId).not.toBe(priorHouseholdId);

            // They lead the NEW household, and the old one is left leadless.
            const moved = await prisma.person.findUnique({ where: { id: testParticipantId } });
            expect(moved?.isHouseholdLead).toBe(true);
            expect(moved?.householdId).toBe(data.participant.householdId);
            const oldLeads = await prisma.person.count({ where: { householdId: priorHouseholdId, isHouseholdLead: true } });
            expect(oldLeads).toBe(0);
        });

        // A youth cannot be a household lead (addHouseholdLead's youth exclusion),
        // and a household with no possible lead must not be created at all — the
        // whole reassign is refused, not partially applied.
        it('refuses createNew on a youth and creates no household', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const twelveYearsAgo = new Date();
            twelveYearsAgo.setFullYear(twelveYearsAgo.getFullYear() - 12);
            await prisma.person.update({
                where: { id: testParticipantId },
                data: { dateOfBirth: twelveYearsAgo }
            });
            const priorHouseholdId = (await prisma.person.findUnique({ where: { id: testParticipantId } }))!.householdId;

            const req = new Request(`http://localhost:4000/api/membership-ops/participants/${testParticipantId}/household`, {
                method: 'POST',
                body: JSON.stringify({ createNew: true })
            });
            const res = await POST(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(testParticipantId) }) });
            expect(res.status).toBe(400);
            expect((await res.json()).error).toMatch(/youth cannot lead a household/i);

            // The household create and the move roll back with the refused promotion.
            const unmoved = await prisma.person.findUnique({ where: { id: testParticipantId } });
            expect(unmoved?.householdId).toBe(priorHouseholdId);
            expect(await prisma.household.count({ where: { name: "Subject Test's Household" } })).toBe(0);
        });

        it('refuses createNew on a youth already flagged a lead, leaving the flag as it was', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const twelveYearsAgo = new Date();
            twelveYearsAgo.setFullYear(twelveYearsAgo.getFullYear() - 12);
            await prisma.person.update({
                where: { id: testParticipantId },
                data: { dateOfBirth: twelveYearsAgo, isHouseholdLead: true }
            });

            const req = new Request(`http://localhost:4000/api/membership-ops/participants/${testParticipantId}/household`, {
                method: 'POST',
                body: JSON.stringify({ createNew: true })
            });
            const res = await POST(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(testParticipantId) }) });
            expect(res.status).toBe(400);

            // The de-lead that precedes the promotion must roll back too — a refused
            // reassign leaves the person exactly as it found them.
            const unmoved = await prisma.person.findUnique({ where: { id: testParticipantId } });
            expect(unmoved?.isHouseholdLead).toBe(true);
        });
    });
});
