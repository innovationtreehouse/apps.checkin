/**
 * @jest-environment node
 */
/**
 * Integration Tests for Admin Households API
 * Tests GET and POST /api/membership-ops/households for fetching and updating memberships
 */

import { GET, POST } from '@/app/api/membership-ops/households/route';
import prisma from '@/lib/prisma';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';
import { getServerSession } from 'next-auth/next';
import { bgValidUntilBoundary } from '@/lib/membership/renewal';

// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

describe('Admin Households API Integration Tests', () => {
    let testAdminId: number;
    let testUserId: number;
    let testHousehold1Id: number;
    let testHousehold2Id: number;
    let testProgramId: number;

    // BG "valid until" fixtures (addendum): a dedicated household with two leads
    // (B checked later than A) and a non-lead PERSON_BG-subject stand-in (C, latest
    // of all) plus a member with no check on file (D).
    let bgHouseholdId: number;
    let leadAId: number;
    let leadBId: number;
    let nonLeadCId: number;
    let memberDId: number;
    const bgBoundary = new Date(Date.UTC(2000, 7, 1)); // Aug 1 (year ignored)
    const bgRecheckMonths = 12;
    const bgSettings = { orgMembershipYearBoundary: bgBoundary, bgRecheckMonths };
    // Spaced so each raw expiry (check + 12mo) lands in a DIFFERENT boundary occurrence
    // window (not just a later date within the same window) — otherwise "later lead
    // wins" and "non-lead is later than the household value" would hold trivially even
    // if the code picked the wrong member.
    const leadALastCheck = new Date(Date.UTC(2025, 0, 1)); // raw expiry 2026-01-01 -> Aug 1 2026
    const leadBLastCheck = new Date(Date.UTC(2025, 8, 1)); // raw expiry 2026-09-01 (past Aug 1 2026) -> Aug 1 2027 — later than A
    const nonLeadCLastCheck = new Date(Date.UTC(2026, 8, 1)); // raw expiry 2027-09-01 (past Aug 1 2027) -> Aug 1 2028 — later than the household (leads-only) value
    let restoreBoardSettings: () => Promise<void> = async () => {};

    beforeAll(async () => {
        restoreBoardSettings = await snapshotBoardSettings();
        await prisma.boardSettings.upsert({
            where: { id: 1 },
            create: { id: 1, orgMembershipYearBoundary: bgBoundary, bgRecheckMonths },
            update: { orgMembershipYearBoundary: bgBoundary, bgRecheckMonths },
        });

        // Clean up any leaked state
        await prisma.programParticipant.deleteMany({
            where: { program: { name: { contains: 'Households API Test' } } }
        });
        await prisma.program.deleteMany({
            where: { name: { contains: 'Households API Test' } }
        });
        await prisma.orgMembership.deleteMany({});
        await prisma.person.deleteMany({
            where: { email: { contains: 'households-api-test' } }
        });
        await prisma.household.deleteMany({
            where: { name: { contains: 'Households API Test' } }
        });

        // BG "valid until" fixtures — created AFTER the leaked-state cleanup above (its
        // name/email patterns match "Households API Test"/"households-api-test", so
        // creating these first would just have them wiped out by the next few lines).
        const bgHousehold = await prisma.household.create({ data: { name: 'Households API Test BG' } });
        bgHouseholdId = bgHousehold.id;
        leadAId = (await prisma.person.create({
            data: { email: 'lead-a-households-api-test@example.com', name: 'Lead A', householdId: bgHouseholdId, isHouseholdLead: true, lastBackgroundCheck: leadALastCheck },
        })).id;
        leadBId = (await prisma.person.create({
            data: { email: 'lead-b-households-api-test@example.com', name: 'Lead B', householdId: bgHouseholdId, isHouseholdLead: true, lastBackgroundCheck: leadBLastCheck },
        })).id;
        nonLeadCId = (await prisma.person.create({
            data: { email: 'nonlead-c-households-api-test@example.com', name: 'Non-Lead C', householdId: bgHouseholdId, isHouseholdLead: false, lastBackgroundCheck: nonLeadCLastCheck },
        })).id;
        memberDId = (await prisma.person.create({
            data: { email: 'member-d-households-api-test@example.com', name: 'Member D', householdId: bgHouseholdId, isHouseholdLead: false, lastBackgroundCheck: null },
        })).id;

        // Setup mock database records
        const admin = await prisma.person.create({
            data: { email: 'admin-households-api-test@example.com', name: 'Admin Households Test', isSysadmin: true, household: { create: { name: "Test HH" } } }
        });
        testAdminId = admin.id;

        const household1 = await prisma.household.create({
            data: { name: 'Households API Test 1' }
        });
        testHousehold1Id = household1.id;

        const household2 = await prisma.household.create({
            data: { name: 'Households API Test 2' }
        });
        testHousehold2Id = household2.id;

        // Add user to household 2 for search testing
        const user = await prisma.person.create({
            data: { email: 'user-households-api-test@example.com', name: 'User Households Test', householdId: testHousehold2Id }
        });
        testUserId = user.id;

        // Create an existing active membership for household 2
        await prisma.orgMembership.create({
            data: {
                householdId: testHousehold2Id,
                status: 'ACTIVE'
            }
        });

        // Enroll the household-2 member in a program so the single-household
        // (?id=) branch has an enrollment to surface for the detail view.
        const program = await prisma.program.create({
            data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Households API Test Program' }
        });
        testProgramId = program.id;
        await prisma.programParticipant.create({
            data: { programId: testProgramId, personId: testUserId, status: 'ACTIVE' }
        });
    });

    afterAll(async () => {
        // Clean up — scope membership deletes to this test's households
        await prisma.programParticipant.deleteMany({
            where: { programId: testProgramId }
        });
        await prisma.program.deleteMany({
            where: { id: testProgramId }
        });
        await prisma.orgMembership.deleteMany({
            where: { householdId: { in: [testHousehold1Id, testHousehold2Id] } }
        });
        await prisma.person.deleteMany({
            where: { id: { in: [testAdminId, testUserId] } }
        });
        await prisma.household.deleteMany({
            where: { id: { in: [testHousehold1Id, testHousehold2Id] } }
        });

        await prisma.person.deleteMany({ where: { id: { in: [leadAId, leadBId, nonLeadCId, memberDId] } } });
        await prisma.household.deleteMany({ where: { id: bgHouseholdId } });
        await restoreBoardSettings();
    });

    describe('GET /api/membership-ops/households', () => {
        it('should return 403 Forbidden without session or admin', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({
                 user: { id: testUserId, isSysadmin: false, isBoardMember: false }
             });

             const req = new Request('http://localhost:4000/api/membership-ops/households', { method: 'GET' });

             const res = await GET(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(403);
        });

        it('should return all households when no query is provided', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true }
            });

            const req = new Request('http://localhost:4000/api/membership-ops/households', { method: 'GET' });

            const res = await GET(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.households).toBeDefined();
            expect(Array.isArray(data.households)).toBe(true);
            
            const h1 = data.households.find((h: { id?: number; email?: string; name?: string; participantId?: number; level?: string; status?: string; role?: string; type?: string; [key: string]: unknown }) => h.id === testHousehold1Id);
            const h2 = data.households.find((h: { id?: number; email?: string; name?: string; participantId?: number; level?: string; status?: string; role?: string; type?: string; [key: string]: unknown }) => h.id === testHousehold2Id);
            expect(h1).toBeDefined();
            expect(h2).toBeDefined();
        });

        it('should filter households based on query', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true }
            });

            // Search by user email in household 2
            const req = new Request('http://localhost:4000/api/membership-ops/households?q=user-households-api-test', { method: 'GET' });

            const res = await GET(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const data = await res.json();
            const h2 = data.households.find((h: { id?: number; email?: string; name?: string; participantId?: number; level?: string; status?: string; role?: string; type?: string; [key: string]: unknown }) => h.id === testHousehold2Id);
            const h1 = data.households.find((h: { id?: number; email?: string; name?: string; participantId?: number; level?: string; status?: string; role?: string; type?: string; [key: string]: unknown }) => h.id === testHousehold1Id);
            
            expect(h2).toBeDefined();
            expect(h1).toBeUndefined(); // Should be filtered out
        });

        it("the seeded household's row bgValidUntil matches the detail household-level value (leads-only, later date)", async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testAdminId, isSysadmin: true } });

            const listReq = new Request('http://localhost:4000/api/membership-ops/households', { method: 'GET' });
            const listRes = await GET(listReq as unknown as import("next/server").NextRequest);
            const listData = await listRes.json();
            const listRow = listData.households.find((h: { id: number }) => h.id === bgHouseholdId);
            expect(listRow).toBeDefined();

            const detailReq = new Request(`http://localhost:4000/api/membership-ops/households?id=${bgHouseholdId}`, { method: 'GET' });
            const detailRes = await GET(detailReq as unknown as import("next/server").NextRequest);
            const detailData = await detailRes.json();

            expect(listRow.bgValidUntil).toBe(detailData.household.bgValidUntil);
        });
    });

    describe('GET /api/membership-ops/households?id= (single household detail)', () => {
        it('returns each member with their program enrollments (name + status)', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true }
            });

            const req = new Request(`http://localhost:4000/api/membership-ops/households?id=${testHousehold2Id}`, { method: 'GET' });

            const res = await GET(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.household).toBeDefined();
            expect(data.household.id).toBe(testHousehold2Id);

            const member = data.household.householdMembers.find((m: { id: number }) => m.id === testUserId);
            expect(member).toBeDefined();
            expect(member.programParticipants).toHaveLength(1);
            expect(member.programParticipants[0].status).toBe('ACTIVE');
            expect(member.programParticipants[0].program.name).toBe('Households API Test Program');
        });

        it('returns an empty enrollment list for a member in no programs', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true }
            });

            // Household 1 has no members; add a bare person to assert the empty case.
            const loner = await prisma.person.create({
                data: { email: 'loner-households-api-test@example.com', name: 'Loner Households Test', householdId: testHousehold1Id }
            });

            const req = new Request(`http://localhost:4000/api/membership-ops/households?id=${testHousehold1Id}`, { method: 'GET' });
            const res = await GET(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const data = await res.json();
            const member = data.household.householdMembers.find((m: { id: number }) => m.id === loner.id);
            expect(member).toBeDefined();
            expect(member.programParticipants).toEqual([]);

            await prisma.person.deleteMany({ where: { id: loner.id } });
        });

        it('bgValidUntil: member with a check vs without (A/B/C non-null, D null)', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testAdminId, isSysadmin: true } });

            const req = new Request(`http://localhost:4000/api/membership-ops/households?id=${bgHouseholdId}`, { method: 'GET' });
            const res = await GET(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const data = await res.json();
            const members: { id: number; bgValidUntil: string | null }[] = data.household.householdMembers;
            const a = members.find((m) => m.id === leadAId);
            const b = members.find((m) => m.id === leadBId);
            const c = members.find((m) => m.id === nonLeadCId);
            const d = members.find((m) => m.id === memberDId);
            expect(a?.bgValidUntil).not.toBeNull();
            expect(b?.bgValidUntil).not.toBeNull();
            expect(c?.bgValidUntil).not.toBeNull();
            expect(d?.bgValidUntil).toBeNull();
        });

        it('bgValidUntil: two leads, the LATER one (B) wins at the household level', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testAdminId, isSysadmin: true } });

            const req = new Request(`http://localhost:4000/api/membership-ops/households?id=${bgHouseholdId}`, { method: 'GET' });
            const res = await GET(req as unknown as import("next/server").NextRequest);
            const data = await res.json();

            const expected = bgValidUntilBoundary(leadBLastCheck, bgSettings);
            expect(new Date(data.household.bgValidUntil).getTime()).toBe(expected!.getTime());
        });

        it('bgValidUntil: a non-lead (C) shows individually but does not affect the household (leads-only) value', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: testAdminId, isSysadmin: true } });

            const req = new Request(`http://localhost:4000/api/membership-ops/households?id=${bgHouseholdId}`, { method: 'GET' });
            const res = await GET(req as unknown as import("next/server").NextRequest);
            const data = await res.json();

            const c = data.household.householdMembers.find((m: { id: number }) => m.id === nonLeadCId);
            expect(c.bgValidUntil).not.toBeNull();
            // C's own check is later than either lead's, so C's individual bgValidUntil is
            // later than the household's leads-only value.
            expect(new Date(c.bgValidUntil).getTime()).toBeGreaterThan(new Date(data.household.bgValidUntil).getTime());
        });
    });

    describe('POST /api/membership-ops/households', () => {
        it('should return 403 Forbidden without session or admin', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({
                 user: { id: testUserId, isSysadmin: false }
             });

             const req = new Request('http://localhost:4000/api/membership-ops/households', {
                 method: 'POST',
                 body: JSON.stringify({ householdId: testHousehold1Id, active: true })
             });

             const res = await POST(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(403);
        });

        it('should return 400 Bad Request if householdId is missing', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true }
            });

            const req = new Request('http://localhost:4000/api/membership-ops/households', {
                method: 'POST',
                body: JSON.stringify({ active: true })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(400);
        });

        it('should successfully activate membership for a household', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true }
            });

            const req = new Request('http://localhost:4000/api/membership-ops/households', {
                method: 'POST',
                body: JSON.stringify({ householdId: testHousehold1Id, active: true })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.success).toBe(true);
            expect(data.membership.status).toBe('ACTIVE');

            const membership = await prisma.orgMembership.findFirst({
                where: { householdId: testHousehold1Id, status: 'ACTIVE' }
            });
            expect(membership).toBeDefined();
        });

        it('should successfully deactivate membership for a household', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true }
            });

            const req = new Request('http://localhost:4000/api/membership-ops/households', {
                method: 'POST',
                body: JSON.stringify({ householdId: testHousehold2Id, active: false })
            });

            const res = await POST(req as unknown as import("next/server").NextRequest);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.success).toBe(true);

            const activeMembership = await prisma.orgMembership.findFirst({
                where: { householdId: testHousehold2Id, status: 'ACTIVE' }
            });
            expect(activeMembership).toBeNull(); // Should be deactivated
        });
    });
});
