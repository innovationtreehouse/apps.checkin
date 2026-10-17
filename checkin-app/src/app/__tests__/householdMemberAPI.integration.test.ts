/**
 * @jest-environment node
 */
/**
 * Integration Tests for User Household Member API
 * Tests PATCH /api/household/member for household leads editing their members
 */

import { PATCH } from '@/app/api/household/member/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn()
}));
describe('Household Member API Integration Tests', () => {
    let testLeadId: number;
    let testMemberId: number;
    let testNonLeadId: number;
    let testOtherMemberId: number;
    let householdId: number;
    let otherHouseholdId: number;

    beforeAll(async () => {
        // Clean up any leaked state
        const existingUsers = await prisma.person.findMany({
            where: { email: { contains: 'member-api-test' } },
            select: { id: true, householdId: true }
        });
        
        const existingUserIds = existingUsers.map(u => u.id);
        const existingHouseholdIds = existingUsers.map(u => u.householdId).filter(id => id !== null) as number[];

        await prisma.orgMembership.deleteMany({
            where: { householdId: { in: existingHouseholdIds } }
        });
        
        await prisma.auditLog.deleteMany({
            where: { actorId: { in: existingUserIds } }
        });

        // RESTRICT: delete participants before their households
        await prisma.person.deleteMany({
            where: { id: { in: existingUserIds } }
        });

        await prisma.household.deleteMany({
            where: { id: { in: existingHouseholdIds } }
        });

        // Setup mock database records
        const household = await prisma.household.create({
            data: { name: 'Member Test Household' }
        });
        householdId = household.id;

        const leadUser = await prisma.person.create({
            data: { email: 'lead-member-api-test@example.com', name: 'Lead User', householdId: household.id }
        });
        testLeadId = leadUser.id;

        await prisma.person.update({ where: { id: leadUser.id }, data: { isHouseholdLead: true } });

        const memberUser = await prisma.person.create({
            data: { email: 'child-member-api-test@example.com', name: 'Child User', householdId: household.id }
        });
        testMemberId = memberUser.id;

        const nonLeadUser = await prisma.person.create({
            data: { email: 'nonlead-member-api-test@example.com', name: 'Non-Lead Adult', householdId: household.id }
        });
        testNonLeadId = nonLeadUser.id;

        const otherHousehold = await prisma.household.create({
            data: { name: 'Other Member Test Household' }
        });
        otherHouseholdId = otherHousehold.id;

        const otherMember = await prisma.person.create({
            data: { email: 'other-child-member-api-test@example.com', name: 'Other Child', householdId: otherHousehold.id }
        });
        testOtherMemberId = otherMember.id;
    });

    afterAll(async () => {
        const currentIds = [testLeadId, testMemberId, testNonLeadId, testOtherMemberId];
        const validHouseholdIds = [householdId, otherHouseholdId];

        await prisma.orgMembership.deleteMany({
            where: { householdId: { in: validHouseholdIds } }
        });
        
        await prisma.auditLog.deleteMany({
            where: { actorId: { in: currentIds } }
        });

        // RESTRICT: delete participants before their households
        await prisma.person.deleteMany({
            where: { id: { in: currentIds } }
        });

        await prisma.household.deleteMany({
            where: { id: { in: validHouseholdIds } }
        });
    });

    describe('PATCH /api/household/member', () => {
        it('should return 401 Unauthorized without session', async () => {
             (getServerSession as jest.Mock).mockResolvedValue(null);

             const req = new Request('http://localhost:4000/api/household/member', {
                 method: 'PATCH',
                 body: JSON.stringify({ participantId: testMemberId, name: 'Changed' })
             });
             const res = await PATCH(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(401);
        });

        it('should return 400 Bad Request if participantId is omitted', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testLeadId } });

            const req = new Request('http://localhost:4000/api/household/member', {
                method: 'PATCH',
                body: JSON.stringify({ name: 'Changed' })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toBe('Participant ID is required');
        });

        it('should reject if the submitting user is not a lead', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testNonLeadId } });

            const req = new Request('http://localhost:4000/api/household/member', {
                method: 'PATCH',
                body: JSON.stringify({ participantId: testMemberId, name: 'Changed' })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(403);
            const data = await res.json();
            expect(data.error).toBe('Only household leads can edit household members');
        });

        it('should return 404 Not Found if trying to edit a member outside of your household', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testLeadId } });

            const req = new Request('http://localhost:4000/api/household/member', {
                method: 'PATCH',
                body: JSON.stringify({ participantId: testOtherMemberId, name: 'Stolen' })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(404);
            const data = await res.json();
            expect(data.error).toBe('That household member was not found');
        });

        it('should successfully update a household member', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testLeadId } });

            const newDob = '2010-05-15';
            const req = new Request('http://localhost:4000/api/household/member', {
                method: 'PATCH',
                body: JSON.stringify({ 
                    participantId: testMemberId, 
                    name: 'Updated Child', 
                    email: 'updated-child@example.com',
                    dob: newDob,
                    phone: '555-555-5555'
                })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);
            
            const data = await res.json();
            expect(data.householdMember).toBeDefined();
            expect(data.message).toBe('Household member updated successfully.');

            // Validate the changes
            const updatedProfile = await prisma.person.findUnique({ where: { id: testMemberId } });
            expect(updatedProfile?.name).toBe('Updated Child');
            expect(updatedProfile?.email).toBe('updated-child@example.com');
            expect(updatedProfile?.phone).toBe('555-555-5555');
            expect(updatedProfile?.dateOfBirth?.toISOString().startsWith(newDob)).toBe(true);

            // Verify Audit Trail is populated
            const auditLogs = await prisma.auditLog.findMany({
                where: { actorId: testLeadId, action: 'EDIT', tableName: 'Person', affectedEntityId: testMemberId }
            });
            expect(auditLogs.length).toBeGreaterThan(0);
        });

        it('should reject a blank name and leave the stored name unchanged', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testLeadId } });

            const req = new Request('http://localhost:4000/api/household/member', {
                method: 'PATCH',
                body: JSON.stringify({ participantId: testMemberId, name: '   ' })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(400);

            const updatedProfile = await prisma.person.findUnique({ where: { id: testMemberId } });
            expect(updatedProfile?.name).toBe('Updated Child');
        });

        it('should blank out email and dob if empty strings are sent', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testLeadId } });

            const req = new Request('http://localhost:4000/api/household/member', {
                method: 'PATCH',
                body: JSON.stringify({ 
                    participantId: testMemberId, 
                    email: '',
                    dob: '',
                    phone: ''
                })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const updatedProfile = await prisma.person.findUnique({ where: { id: testMemberId } });
            expect(updatedProfile?.email).toBeNull();
            expect(updatedProfile?.dateOfBirth).toBeNull();
            expect(updatedProfile?.phone).toBeNull();
        });

        // #1149 F1 / #1447: this form once stored DoB at noon UTC while every
        // other writer stored midnight. A non-midnight DoB fails an SQL age
        // filter cut at UTC midnight, so the student who turns 18 exactly on the
        // member-year boundary — the row the 18+ roster exists to show — is
        // silently dropped while calculateAge still reports them as 18.
        it('stores a DoB at UTC midnight so a boundary birthday passes a UTC-midnight age cutoff', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testLeadId } });

            const birthCutoff = new Date(Date.UTC(new Date().getUTCFullYear() - 18, 8, 1));
            const dob = birthCutoff.toISOString().slice(0, 10);

            const req = new Request('http://localhost:4000/api/household/member', {
                method: 'PATCH',
                body: JSON.stringify({ participantId: testMemberId, dob })
            });

            const res = await PATCH(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const updatedProfile = await prisma.person.findUnique({ where: { id: testMemberId } });
            expect(updatedProfile?.dateOfBirth?.toISOString()).toBe(`${dob}T00:00:00.000Z`);

            const onRoster = await prisma.person.findFirst({
                where: { id: testMemberId, dateOfBirth: { lte: birthCutoff } },
                select: { id: true }
            });
            expect(onRoster).not.toBeNull();
        });

        it('should allow a lead to designate another adult as a lead', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testLeadId } });

             const req = new Request('http://localhost:4000/api/household/member', {
                 method: 'PATCH',
                 body: JSON.stringify({ 
                     participantId: testNonLeadId, 
                     isLead: true
                 })
             });

             const res = await PATCH(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(200);

             // Verify they are now a lead
             const leadRecord = await prisma.person.findFirst({
                 where: { id: testNonLeadId, householdId: householdId, isHouseholdLead: true },
                 select: { id: true }
             });
             expect(leadRecord).not.toBeNull();
        });

        it('should allow a lead to remove another lead', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testLeadId } });

             const req = new Request('http://localhost:4000/api/household/member', {
                 method: 'PATCH',
                 body: JSON.stringify({ 
                     participantId: testNonLeadId, 
                     isLead: false
                 })
             });

             const res = await PATCH(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(200);

             // Verify they are no longer a lead
             const leadRecord = await prisma.person.findFirst({
                 where: { id: testNonLeadId, householdId: householdId, isHouseholdLead: true },
                 select: { id: true }
             });
             expect(leadRecord).toBeNull();
        });

        it('should prevent deleting the last lead in a household', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testLeadId } });

             const req = new Request('http://localhost:4000/api/household/member', {
                 method: 'PATCH',
                 body: JSON.stringify({ 
                     participantId: testLeadId, 
                     isLead: false
                 })
             });

             const res = await PATCH(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(200); // the edit still succeeds technically even if it ignored the lea demotion request since it doesn't hard error it, this is intended

             // Verify they are STILL a lead
             const leadRecord = await prisma.person.findFirst({
                 where: { id: testLeadId, householdId: householdId, isHouseholdLead: true },
                 select: { id: true }
             });
             expect(leadRecord).not.toBeNull();
        });
    });
});
