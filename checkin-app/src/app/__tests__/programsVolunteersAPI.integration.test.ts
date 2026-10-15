/**
 * @jest-environment node
 */
/**
 * Integration Tests for Program Volunteers API
 * Tests POST, PATCH, and DELETE /api/programs/[id]/volunteers for managing staff
 */

import { POST, PATCH, DELETE } from '@/app/api/programs/[id]/volunteers/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { SELF_GRANT_REFUSAL_TABLE } from '@/lib/membership/selfGrantGuard';
// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));
describe('Program Volunteers API Integration Tests', () => {
    let adminId: number;
    let leadId: number;
    let commonId: number;
    
    let candidateId: number; // For testing POST
    let existingVolunteerId: number; // For testing PATCH & DELETE
    let youthVolunteerId: number;
    let treasurerId: number;
    let leadSpouseId: number; // In the lead's own household
    
    let targetProgramId: number;

    beforeAll(async () => {
        // Clean up any leaked state
        const existingUsers = await prisma.person.findMany({
            where: { email: { contains: 'volun-api-test' } },
            select: { id: true }
        });
        const existingUserIds = existingUsers.map(u => u.id);
        
        await prisma.programVolunteer.deleteMany({
            where: { personId: { in: existingUserIds } }
        });

        await prisma.program.deleteMany({
            where: { name: { contains: 'Volun API Test' } }
        });
        
        await prisma.auditLog.deleteMany({
            where: { actorId: { in: existingUserIds } }
        });
        
        await prisma.person.deleteMany({
            where: { id: { in: existingUserIds } }
        });

        // Create Roles
        const admin = await prisma.person.create({
            data: { email: 'admin-volun-api-test@example.com', name: 'Admin', isSysadmin: true, household: { create: { name: "Test HH" } } }
        });
        adminId = admin.id;

        const lead = await prisma.person.create({
            data: { email: 'lead-volun-api-test@example.com', name: 'Lead', household: { create: { name: "Test HH" } } }
        });
        leadId = lead.id;

        const leadSpouse = await prisma.person.create({
            data: { email: 'spouse-volun-api-test@example.com', name: 'Lead Spouse', isDeclaredAdult: true, householdId: lead.householdId }
        });
        leadSpouseId = leadSpouse.id;

        const commonUser = await prisma.person.create({
            data: { email: 'common-volun-api-test@example.com', name: 'Common', household: { create: { name: "Test HH" } } }
        });
        commonId = commonUser.id;

        const candidate = await prisma.person.create({
            data: { email: 'candidate-volun-api-test@example.com', name: 'Candidate', household: { create: { name: "Test HH" } } }
        });
        candidateId = candidate.id;

        const existingVol = await prisma.person.create({
            data: { email: 'existing-volun-api-test@example.com', name: 'Existing Volunteer', isDeclaredAdult: true, household: { create: { name: "Test HH" } } }
        });
        existingVolunteerId = existingVol.id;

        const youthVol = await prisma.person.create({
            data: { email: 'youth-volun-api-test@example.com', name: 'Youth Volunteer', dateOfBirth: new Date('2014-01-01'), household: { create: { name: "Test HH" } } }
        });
        youthVolunteerId = youthVol.id;

        const treasurer = await prisma.person.create({
            data: { email: 'treasurer-volun-api-test@example.com', name: 'Treasurer', household: { create: { name: "Test HH" } } }
        });
        treasurerId = treasurer.id;

        // Create mock program
        const program = await prisma.program.create({
            data: { 
                startAt: new Date('2026-01-01'),
                endAt: new Date('2026-12-31'),
                name: 'Volun API Test Program', 
                phase: 'RUNNING', 
                leadMentorId: leadId,
                volunteers: {
                    create: [
                        { personId: existingVolunteerId, isCore: false },
                        { personId: youthVolunteerId, isCore: false },
                        { personId: treasurerId, isCore: false, isTreasurer: true },
                        { personId: leadSpouseId, isCore: false },
                    ]
                }
            }
        });
        targetProgramId = program.id;
    });

    afterAll(async () => {
        const existingUserIds = [adminId, leadId, commonId, candidateId, existingVolunteerId, youthVolunteerId, treasurerId, leadSpouseId].filter(id => id !== undefined);

        if (existingUserIds.length > 0) {
            await prisma.programVolunteer.deleteMany({
                where: { personId: { in: existingUserIds } }
            });
        }

        if (targetProgramId) {
            await prisma.program.deleteMany({
                where: { id: targetProgramId }
            });
        }
        
        if (existingUserIds.length > 0) {
            await prisma.auditLog.deleteMany({
                where: { actorId: { in: existingUserIds } }
            });
            
            await prisma.person.deleteMany({
                where: { id: { in: existingUserIds } }
            });
        }
    });

    const createParams = (id: number) => ({ params: Promise.resolve({ id: id.toString() }) });

    describe('POST /api/programs/[id]/volunteers', () => {
        it('should return 401 Unauthorized without session', async () => {
             (getServerSession as jest.Mock).mockResolvedValue(null);

             const req = new Request(`http://localhost:4000/api/programs/${targetProgramId}/volunteers`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: candidateId })
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(targetProgramId) as unknown as never);
             expect(res.status).toBe(401);
        });

        it('should block common users from assigning a volunteer', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } });

             const req = new Request(`http://localhost:4000/api/programs/${targetProgramId}/volunteers`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: candidateId })
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(targetProgramId) as unknown as never);
             expect(res.status).toBe(403);
             
             const data = await res.json();
             expect(data.error).toMatch(/Forbidden/);
        });

        it('should allow the program lead to assign a new volunteer', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });

             const req = new Request(`http://localhost:4000/api/programs/${targetProgramId}/volunteers`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: candidateId })
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(targetProgramId) as unknown as never);
             expect(res.status).toBe(200);

             const data = await res.json();
             expect(data.success).toBe(true);
             expect(data.assignment.isCore).toBe(false); // Default logic
             expect(data.assignment.personId).toBe(candidateId);

             // Persisted: a ProgramVolunteer row now exists for this pair.
             const row = await prisma.programVolunteer.findUnique({
                 where: { programId_personId: { programId: targetProgramId, personId: candidateId } }
             });
             expect(row).not.toBeNull();
        });

        it('should return 409, not 500, when assigning an already-assigned volunteer', async () => {
             // candidateId was assigned by the previous test; re-assigning is a
             // duplicate (P2002).
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });

             const req = new Request(`http://localhost:4000/api/programs/${targetProgramId}/volunteers`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: candidateId })
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(targetProgramId) as unknown as never);
             expect(res.status).toBe(409);
        });

        it('should return 400 when participantId is missing', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });

             const req = new Request(`http://localhost:4000/api/programs/${targetProgramId}/volunteers`, {
                 method: 'POST',
                 body: JSON.stringify({})
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(targetProgramId) as unknown as never);
             expect(res.status).toBe(400);
        });

        it('should return a clean 400, not 500, for a non-existent participant', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });

             const req = new Request(`http://localhost:4000/api/programs/${targetProgramId}/volunteers`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: 2147483647 }) // no such Participant row
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(targetProgramId) as unknown as never);
             expect(res.status).toBe(400);
             expect(res.status).not.toBe(500);
        });

        it('refuses a merged-away record and assigns no one', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });
             const created = await prisma.person.create({
                 data: { email: 'tombstone-volun-api-test@example.com', name: 'Tombstone', household: { create: { name: "Test HH" } } }
             });
             const tombstone = await prisma.person.update({ where: { id: created.id }, data: { mergedIntoId: candidateId } });
             try {
                 const req = new Request(`http://localhost:4000/api/programs/${targetProgramId}/volunteers`, {
                     method: 'POST',
                     body: JSON.stringify({ participantId: tombstone.id })
                 });
                 const res = await POST(req as unknown as import("next/server").NextRequest, createParams(targetProgramId) as unknown as never);
                 expect(res.status).toBe(400);
                 expect(await prisma.programVolunteer.count({ where: { personId: tombstone.id } })).toBe(0);
             } finally {
                 await prisma.programVolunteer.deleteMany({ where: { personId: tombstone.id } });
                 await prisma.person.delete({ where: { id: tombstone.id } });
             }
        });

        it.each([
            ['themself', () => leadId],
            ['someone in their own household', () => leadSpouseId],
        ])('refuses a lead mentor adding %s, with an audited refusal', async (_label, subjectId) => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });
             const before = await prisma.programVolunteer.count({ where: { programId: targetProgramId } });

             const req = new Request(`http://localhost:4000/api/programs/${targetProgramId}/volunteers`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: subjectId() })
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(targetProgramId) as unknown as never);
             expect(res.status).toBe(403);

             expect(await prisma.programVolunteer.count({ where: { programId: targetProgramId } })).toBe(before);
             const refusal = await prisma.auditLog.findFirst({
                 where: { actorId: leadId, tableName: SELF_GRANT_REFUSAL_TABLE, affectedEntityId: subjectId() }
             });
             expect(refusal).not.toBeNull();
        });

        it('documents intent: any participant is assignable (no age/membership gate)', async () => {
             // The candidate has no dateOfBirth and is not a program member, yet
             // assignment succeeded above. Volunteers are staff, not enrollees —
             // there is intentionally no eligibility rule. If product adds one,
             // this test should change deliberately.
             const candidate = await prisma.person.findUnique({ where: { id: candidateId } });
             expect(candidate?.dateOfBirth).toBeNull();
             const row = await prisma.programVolunteer.findUnique({
                 where: { programId_personId: { programId: targetProgramId, personId: candidateId } }
             });
             expect(row).not.toBeNull();
        });
    });

    describe('PATCH /api/programs/[id]/volunteers', () => {
        it('should block common users from updating a volunteer', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } });

             const req = new Request(`http://localhost:4000/api/programs/${targetProgramId}/volunteers`, {
                 method: 'PATCH',
                 body: JSON.stringify({ participantId: existingVolunteerId, isCore: true })
             });
             const res = await PATCH(req as unknown as import("next/server").NextRequest, createParams(targetProgramId) as unknown as never);
             expect(res.status).toBe(403);
        });

        it('should require isCore and participantId', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

             const req = new Request(`http://localhost:4000/api/programs/${targetProgramId}/volunteers`, {
                 method: 'PATCH',
                 body: JSON.stringify({ participantId: existingVolunteerId }) // missing isCore
             });
             const res = await PATCH(req as unknown as import("next/server").NextRequest, createParams(targetProgramId) as unknown as never);
             expect(res.status).toBe(400);
             
             const data = await res.json();
             expect(data.error).toBe("participantId and isCore are required");
        });

        const patch = (participantId: number, isCore: boolean) => PATCH(
            new Request(`http://localhost:4000/api/programs/${targetProgramId}/volunteers`, {
                method: 'PATCH',
                body: JSON.stringify({ participantId, isCore })
            }) as unknown as import("next/server").NextRequest,
            createParams(targetProgramId) as unknown as never
        );

        it('refuses to make a youth a core volunteer, even for an admin', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });
             const res = await patch(youthVolunteerId, true);
             expect(res.status).toBe(400);
             expect((await res.json()).error).toBe("A core volunteer must be an adult.");
        });

        it('refuses to make someone of unknown age a core volunteer', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });
             const res = await patch(treasurerId, true);
             expect(res.status).toBe(400);
        });

        it('still lets a youth be un-cored', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });
             const res = await patch(youthVolunteerId, false);
             expect(res.status).toBe(200);
        });

        it('refuses a lead mentor making their own household core, with an audited refusal', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });

             const req = new Request(`http://localhost:4000/api/programs/${targetProgramId}/volunteers`, {
                 method: 'PATCH',
                 body: JSON.stringify({ participantId: leadSpouseId, isCore: true })
             });
             const res = await PATCH(req as unknown as import("next/server").NextRequest, createParams(targetProgramId) as unknown as never);
             expect(res.status).toBe(403);

             const row = await prisma.programVolunteer.findUnique({
                 where: { programId_personId: { programId: targetProgramId, personId: leadSpouseId } }
             });
             expect(row?.isCore).toBe(false);
             const refusal = await prisma.auditLog.findFirst({
                 where: { actorId: leadId, tableName: SELF_GRANT_REFUSAL_TABLE, affectedEntityId: leadSpouseId }
             });
             expect(refusal).not.toBeNull();
        });

        it('lets a lead mentor clear core on their own household', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });

             const req = new Request(`http://localhost:4000/api/programs/${targetProgramId}/volunteers`, {
                 method: 'PATCH',
                 body: JSON.stringify({ participantId: leadSpouseId, isCore: false })
             });
             const res = await PATCH(req as unknown as import("next/server").NextRequest, createParams(targetProgramId) as unknown as never);
             expect(res.status).toBe(200);
        });

        it('lets a lead mentor make someone outside their household core', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });

             const req = new Request(`http://localhost:4000/api/programs/${targetProgramId}/volunteers`, {
                 method: 'PATCH',
                 body: JSON.stringify({ participantId: existingVolunteerId, isCore: true })
             });
             const res = await PATCH(req as unknown as import("next/server").NextRequest, createParams(targetProgramId) as unknown as never);
             expect(res.status).toBe(200);
        });

        it('should allow admins to toggle the isCore flag of a volunteer', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

             const req = new Request(`http://localhost:4000/api/programs/${targetProgramId}/volunteers`, {
                 method: 'PATCH',
                 body: JSON.stringify({ participantId: existingVolunteerId, isCore: true })
             });
             const res = await PATCH(req as unknown as import("next/server").NextRequest, createParams(targetProgramId) as unknown as never);
             expect(res.status).toBe(200);
             
             const data = await res.json();
             expect(data.assignment.isCore).toBe(true);
        });
    });

    describe('DELETE /api/programs/[id]/volunteers', () => {
        it('should block common users from removing a volunteer', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } });

             const req = new Request(`http://localhost:4000/api/programs/${targetProgramId}/volunteers`, {
                 method: 'DELETE',
                 body: JSON.stringify({ participantId: existingVolunteerId })
             });
             const res = await DELETE(req as unknown as import("next/server").NextRequest, createParams(targetProgramId) as unknown as never);
             expect(res.status).toBe(403);
        });

        const del = (participantId: number) => DELETE(
            new Request(`http://localhost:4000/api/programs/${targetProgramId}/volunteers`, {
                method: 'DELETE',
                body: JSON.stringify({ participantId })
            }) as unknown as import("next/server").NextRequest,
            createParams(targetProgramId) as unknown as never
        );

        it('refuses the lead mentor removing the program treasurer', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });
             const res = await del(treasurerId);
             expect(res.status).toBe(403);
             expect((await res.json()).error).toMatch(/treasurer/);
             const row = await prisma.programVolunteer.findUnique({
                 where: { programId_personId: { programId: targetProgramId, personId: treasurerId } }
             });
             expect(row?.isTreasurer).toBe(true);
        });

        it('lets the board remove the program treasurer', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isBoardMember: true } });
             const res = await del(treasurerId);
             expect(res.status).toBe(200);
        });

        it('should allow the assigned lead mentor to remove a volunteer', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });

             const req = new Request(`http://localhost:4000/api/programs/${targetProgramId}/volunteers`, {
                 method: 'DELETE',
                 body: JSON.stringify({ participantId: existingVolunteerId })
             });
             const res = await DELETE(req as unknown as import("next/server").NextRequest, createParams(targetProgramId) as unknown as never);
             expect(res.status).toBe(200);
             
             const data = await res.json();
             expect(data.success).toBe(true);
             expect(data.assignment.personId).toBe(existingVolunteerId);
        });
    });
});
