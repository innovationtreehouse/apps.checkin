/**
 * @jest-environment node
 */
/**
 * Integration Tests for User Household Lead API
 * Tests POST and DELETE /api/household/lead for household leads managing leads
 */

import { POST, DELETE } from '@/app/api/household/lead/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn()
}));
describe('Household Lead API Integration Tests', () => {
    let testLeadId: number;
    let testAdultId: number;
    let testChildId: number;
    let testYouthId: number;
    let testOtherLeadId: number;
    let testOtherMemberId: number;
    let householdId: number;
    let otherHouseholdId: number;

    beforeAll(async () => {
        // Clean up any leaked state
        const existingUsers = await prisma.person.findMany({
            where: { email: { contains: 'lead-api-test' } },
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
            data: { name: 'Lead Test Household' }
        });
        householdId = household.id;

        const leadUser = await prisma.person.create({
            data: { email: 'lead-lead-api-test@example.com', name: 'Lead User', householdId: household.id }
        });
        testLeadId = leadUser.id;

        await prisma.person.update({ where: { id: leadUser.id }, data: { isHouseholdLead: true } });

        // Adult DOB (30 years ago) — promoting them to lead must succeed.
        const adultDob = new Date();
        adultDob.setFullYear(adultDob.getFullYear() - 30);
        const adultUser = await prisma.person.create({
            data: { email: 'adult-lead-api-test@example.com', name: 'Adult User', householdId: household.id, dateOfBirth: adultDob }
        });
        testAdultId = adultUser.id;

        const childUser = await prisma.person.create({
            data: { email: 'child-lead-api-test@example.com', name: 'Child User', householdId: household.id }
        });
        testChildId = childUser.id;

        // Clearly a youth (DOB 10 years ago) — server must refuse promoting them to lead.
        const youthDob = new Date();
        youthDob.setFullYear(youthDob.getFullYear() - 10);
        const youthUser = await prisma.person.create({
            data: { email: 'youth-lead-api-test@example.com', name: 'Youth User', householdId: household.id, dateOfBirth: youthDob }
        });
        testYouthId = youthUser.id;

        const otherHousehold = await prisma.household.create({
            data: { name: 'Other Lead Test Household' }
        });
        otherHouseholdId = otherHousehold.id;
        
        const otherLead = await prisma.person.create({
            data: { email: 'other-lead-lead-api-test@example.com', name: 'Other Lead User', householdId: otherHousehold.id }
        });
        testOtherLeadId = otherLead.id;

        await prisma.person.update({ where: { id: otherLead.id }, data: { isHouseholdLead: true } });

        const otherMember = await prisma.person.create({
            data: { email: 'other-adult-lead-api-test@example.com', name: 'Other Adult', householdId: otherHousehold.id }
        });
        testOtherMemberId = otherMember.id;
    });

    afterAll(async () => {
        const currentIds = [testLeadId, testAdultId, testChildId, testYouthId, testOtherLeadId, testOtherMemberId];
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

    describe('POST /api/household/lead', () => {
        it('should return 401 Unauthorized without session', async () => {
             (getServerSession as jest.Mock).mockResolvedValue(null);

             const req = new Request('http://localhost:4000/api/household/lead', {
                 method: 'POST',
                 body: JSON.stringify({ participantId: testAdultId })
             });
             const res = await POST(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(401);
        });

        it('should reject if the submitting user is not a lead', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testAdultId } });

            const req = new Request('http://localhost:4000/api/household/lead', {
                method: 'POST',
                body: JSON.stringify({ participantId: testChildId })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(403);
            const data = await res.json();
            expect(data.error).toBe('Only household leads, board members, or sysadmins can promote members');
        });

        it('should return 403 Forbidden if a non-privileged lead tries to promote a member outside of their household', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testLeadId } });

            const req = new Request('http://localhost:4000/api/household/lead', {
                method: 'POST',
                body: JSON.stringify({ participantId: testOtherMemberId })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(403);
            const data = await res.json();
            expect(data.error).toBe('Only household leads, board members, or sysadmins can promote members');
        });

        it('should reject promoting a youth to lead (server-side youth exclusion)', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testLeadId } });

            const req = new Request('http://localhost:4000/api/household/lead', {
                method: 'POST',
                body: JSON.stringify({ participantId: testYouthId })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toBe('A youth cannot be a household lead.');

            // The youth must not have been flagged as a lead.
            const notLead = await prisma.person.findFirst({
                where: { id: testYouthId, householdId, isHouseholdLead: true },
                select: { id: true }
            });
            expect(notLead).toBeNull();
        });

        it('should return successfully when user is already a lead', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testLeadId } });
             
             const req = new Request('http://localhost:4000/api/household/lead', {
                method: 'POST',
                body: JSON.stringify({ participantId: testLeadId })
            });
            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.message).toBe('Member is already a lead');
        });

        it('should successfully promote a household member to lead', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testLeadId } });

            const req = new Request('http://localhost:4000/api/household/lead', {
                method: 'POST',
                body: JSON.stringify({ participantId: testAdultId })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);
            
            const data = await res.json();
            expect(data.lead).toBeDefined();
            expect(data.message).toBe('Member promoted to lead successfully.');

            // Validate the changes
            const newLead = await prisma.person.findFirst({
                where: { id: testAdultId, householdId: householdId, isHouseholdLead: true },
                select: { id: true }
            });
            expect(newLead).not.toBeNull();

            // Verify Audit Trail is populated
            const auditLogs = await prisma.auditLog.findMany({
                where: { actorId: testLeadId, action: 'CREATE', tableName: 'Person', affectedEntityId: testAdultId }
            });
            expect(auditLogs.length).toBeGreaterThan(0);
        });

        it('should reject promoting a third lead (max 2 per household)', async () => {
            // householdId now has two leads: testLeadId and testAdultId (from the
            // previous test). Promoting a third must be rejected.
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testLeadId } });

            const req = new Request('http://localhost:4000/api/household/lead', {
                method: 'POST',
                body: JSON.stringify({ participantId: testChildId })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toBe('A household can have at most 2 leads.');

            // The third member should not have been flagged as a lead.
            const noLead = await prisma.person.findFirst({
                where: { id: testChildId, householdId, isHouseholdLead: true },
                select: { id: true }
            });
            expect(noLead).toBeNull();
        });
    });

    describe('DELETE /api/household/lead', () => {
         it('should return 401 Unauthorized without session', async () => {
             (getServerSession as jest.Mock).mockResolvedValue(null);

             const req = new Request('http://localhost:4000/api/household/lead', {
                 method: 'DELETE',
                 body: JSON.stringify({ participantId: testAdultId })
             });
             const res = await DELETE(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(401);
        });
        
        it('should reject if the submitting user is not a lead', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testChildId } });

            const req = new Request('http://localhost:4000/api/household/lead', {
                method: 'DELETE',
                body: JSON.stringify({ participantId: testAdultId })
            });

            const res = await DELETE(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(403);
            const data = await res.json();
            expect(data.error).toBe('Only household leads, board members, or sysadmins can remove leads');
        });
        
         it('should fail when trying to remove the last lead', async () => {
             // We currently have two leads in `householdId`: testLeadId and testAdultId. 
             // Let's test `otherHouseholdId` which only has `testOtherLeadId`.
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testOtherLeadId } });
             const req = new Request('http://localhost:4000/api/household/lead', {
                 method: 'DELETE',
                 body: JSON.stringify({ participantId: testOtherLeadId })
             });
             const res = await DELETE(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(400);
             const data = await res.json();
             expect(data.error).toBe('Cannot remove the last lead of a household.');
         });
         
        it('should successfully remove a lead if multiple leads exist', async () => {
             // Currently `testAdultId` is a lead from the POST test
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testLeadId } });

            const req = new Request('http://localhost:4000/api/household/lead', {
                method: 'DELETE',
                body: JSON.stringify({ participantId: testAdultId })
            });

            const res = await DELETE(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);
            
            const data = await res.json();
            expect(data.message).toBe('Lead removed successfully.');

            // Validate the changes
            const demotedLead = await prisma.person.findFirst({
                where: { id: testAdultId, householdId: householdId, isHouseholdLead: true },
                select: { id: true }
            });
            expect(demotedLead).toBeNull();
        });

        it('should let a board member remove a lead from a household they do not belong to', async () => {
            // Board member sits in neither household. Give otherHousehold a second
            // lead (testOtherMemberId) so the last-lead guard doesn't fire, then have
            // the board member demote testOtherLeadId.
            const boardHousehold = await prisma.household.create({
                data: { name: 'Board Lead Test Household' }
            });
            const boardUser = await prisma.person.create({
                data: { email: 'board-lead-api-test@example.com', name: 'Board User', isBoardMember: true, householdId: boardHousehold.id }
            });
            await prisma.person.update({ where: { id: testOtherMemberId }, data: { isHouseholdLead: true } });

            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardUser.id } });

            const req = new Request('http://localhost:4000/api/household/lead', {
                method: 'DELETE',
                body: JSON.stringify({ participantId: testOtherLeadId })
            });
            const res = await DELETE(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const removed = await prisma.person.findFirst({
                where: { id: testOtherLeadId, householdId: otherHouseholdId, isHouseholdLead: true },
                select: { id: true }
            });
            expect(removed).toBeNull();
        });
    });
});
