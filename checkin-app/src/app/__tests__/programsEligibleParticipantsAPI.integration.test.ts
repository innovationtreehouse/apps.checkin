/**
 * @jest-environment node
 */
/**
 * Integration Tests for Eligible Participants API
 * Tests GET /api/programs/[id]/eligible-participants for fetching candidates
 */

import { GET } from '@/app/api/programs/[id]/eligible-participants/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));
describe('Eligible Participants API Integration Tests', () => {
    let adminId: number;
    let leadId: number;
    let commonId: number;
    
    let activeMemberId: number;
    let householdMemberId: number;
    let nonMemberId: number;
    let alreadyEnrolledId: number;

    let publicProgramId: number;
    let orgMemberOnlyProgramId: number;
    let testHouseholdId: number;

    const ENV_BEFORE = process.env.CHECKIN_ENV;
    beforeAll(async () => {
        // The route now authenticates via authenticateRequest, whose local-kiosk
        // fallback (CHECKIN_ENV=local) treats a cookieless request as kiosk. Pin to
        // 'dev' so unauthenticated stays unauthenticated (401), like registryAuthz.
        process.env.CHECKIN_ENV = 'dev';
        // Clean up any leaked state
        const existingUsers = await prisma.person.findMany({
            where: { email: { contains: 'elig-api-test' } },
            select: { id: true, householdId: true }
        });
        const existingUserIds = existingUsers.map(u => u.id);
        const existingHouseholdIds = existingUsers
            .map(u => u.householdId)
            .filter((id): id is number => id !== null && id !== undefined);

        await prisma.programParticipant.deleteMany({
            where: { personId: { in: existingUserIds } }
        });

        // Memberships live on the household now; scope cleanup to this test's households.
        await prisma.orgMembership.deleteMany({
             where: { householdId: { in: existingHouseholdIds } }
        });

        await prisma.person.deleteMany({
            where: { id: { in: existingUserIds } }
        });

        await prisma.household.deleteMany({
             where: { id: { in: existingHouseholdIds } }
        });

        await prisma.program.deleteMany({
            where: { name: { contains: 'Elig API Test' } }
        });

        // Create Admin
        const admin = await prisma.person.create({
            data: { email: 'admin-elig-api-test@example.com', name: 'Admin', isSysadmin: true, household: { create: { name: "Test HH" } } }
        });
        adminId = admin.id;

        // Create Lead
        const lead = await prisma.person.create({
            data: { email: 'lead-elig-api-test@example.com', name: 'Lead', household: { create: { name: "Test HH" } } }
        });
        leadId = lead.id;

        // Create Common User
        const commonUser = await prisma.person.create({
            data: { email: 'common-elig-api-test@example.com', name: 'Common', household: { create: { name: "Test HH" } } }
        });
        commonId = commonUser.id;

        // Create Active Member — membership now lives on the household (status ACTIVE).
        const activeMember = await prisma.person.create({
            data: {
                email: 'active-member-elig-api-test@example.com',
                name: 'Active Member Candidate',
                household: {
                    create: {
                        name: "Test HH",
                        orgMembership: {
                            create: {
                                status: 'ACTIVE',
                                memberSince: new Date()
                            }
                        }
                    }
                }
            }
        });
        activeMemberId = activeMember.id;

        // Create Household Member (indirect membership) — membership held by the household.
        const household = await prisma.household.create({
            data: {
                name: 'Elig API Test Household',
                orgMembership: {
                    create: {
                        status: 'ACTIVE',
                        memberSince: new Date()
                    }
                }
            }
        });
        testHouseholdId = household.id;

        const householdMember = await prisma.person.create({
            data: { 
                email: 'household-member-elig-api-test@example.com', 
                name: 'Household Member Candidate',
                householdId: household.id
            }
        });
        householdMemberId = householdMember.id;

        // Create Non-Member
        const nonMember = await prisma.person.create({
            data: {
                email: 'non-member-elig-api-test@example.com',
                name: 'Non Member Candidate',
                household: { create: { name: "Test HH" } }
            }
        });
        nonMemberId = nonMember.id;

        // Create mock programs
        const publicProgram = await prisma.program.create({
            data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Public Elig API Test', phase: 'RUNNING', orgMemberOnly: false, leadMentorId: leadId }
        });
        publicProgramId = publicProgram.id;

        const orgMemberOnlyProgram = await prisma.program.create({
            data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Member Only Elig API Test', phase: 'RUNNING', orgMemberOnly: true, leadMentorId: leadId }
        });
        orgMemberOnlyProgramId = orgMemberOnlyProgram.id;

        // Create already enrolled participant for public program
        const alreadyEnrolled = await prisma.person.create({
            data: {
                email: 'enrolled-elig-api-test@example.com',
                name: 'Already Enrolled Candidate',
                household: { create: { name: "Test HH" } },
                programParticipants: {
                    create: {
                        programId: publicProgramId
                    }
                }
            }
        });
        alreadyEnrolledId = alreadyEnrolled.id;
    });

    afterAll(async () => {
        process.env.CHECKIN_ENV = ENV_BEFORE;
        const existingUserIds = [adminId, leadId, commonId, activeMemberId, householdMemberId, nonMemberId, alreadyEnrolledId].filter(id => id !== undefined);
        const validProgramIds = [publicProgramId, orgMemberOnlyProgramId].filter(id => id !== undefined);

        if (existingUserIds.length > 0) {
            await prisma.programParticipant.deleteMany({
                where: { personId: { in: existingUserIds } }
            });

            // Memberships are held by households. Scope the cleanup to exactly the
            // households this test touched: each test participant's household plus the
            // explicitly created Elig API Test household.
            const testParticipants = await prisma.person.findMany({
                where: { id: { in: existingUserIds } },
                select: { householdId: true }
            });
            const testHouseholdIds = Array.from(new Set(
                testParticipants
                    .map(p => p.householdId)
                    .filter((id): id is number => id !== null && id !== undefined)
                    .concat(testHouseholdId !== undefined ? [testHouseholdId] : [])
            ));

            if (testHouseholdIds.length > 0) {
                await prisma.orgMembership.deleteMany({
                     where: { householdId: { in: testHouseholdIds } }
                });
            }
        }

        if (existingUserIds.length > 0) {
            await prisma.person.deleteMany({
                where: { id: { in: existingUserIds } }
            });
        }

        if (testHouseholdId) {
            await prisma.household.deleteMany({
                where: { id: testHouseholdId }
            });
        }

        if (validProgramIds.length > 0) {
            await prisma.program.deleteMany({
                where: { id: { in: validProgramIds } }
            });
        }
    });

    // Helper function to mock Next.js App Router params
    const createParams = (id: number) => ({ params: Promise.resolve({ id: id.toString() }) });
    // A REAL Request: the route now runs through the security handler(), which
    // calls authenticateRequest(req) and reads req.headers — a bare {nextUrl}
    // mock crashes there. The route reads the query via new URL(req.url).
    const createReq = (id: number, search: string = '') => {
        return new Request(
            `http://localhost:4000/api/programs/${id}/eligible-participants${search ? `?q=${encodeURIComponent(search)}` : ''}`,
            { method: 'GET' },
        ) as unknown as never;
    };

    describe('GET /api/programs/[id]/eligible-participants', () => {
        it('should return 401 Unauthorized without session', async () => {
             (getServerSession as jest.Mock).mockResolvedValue(null);

             const res = await GET(createReq(publicProgramId), createParams(publicProgramId));
             expect(res.status).toBe(401);
        });

        // The shape NextAuth builds when the jwt re-sync misses (person merged away or
        // deleted) and returns an empty token: a user object with no id. An undefined id
        // in a Prisma `where` drops the filter, so this must never reach the resolvers.
        it('should return 401 for a session whose user has no id', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({
                 user: { name: undefined, email: undefined, image: undefined },
             });

             const res = await GET(createReq(publicProgramId, 'Candidate'), createParams(publicProgramId));
             expect(res.status).toBe(401);
        });

        it('should return 404 Not Found for non-existent program', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

             const res = await GET(createReq(999999), createParams(999999));
             expect(res.status).toBe(404);
        });

        it('should block common users from accessing the list', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } });

             const res = await GET(createReq(publicProgramId), createParams(publicProgramId));
             expect(res.status).toBe(403);
             
             const data = await res.json();
             expect(data.error).toMatch(/Forbidden/);
        });

        it('should allow lead mentors to retrieve candidates not currently enrolled', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });

             const res = await GET(createReq(publicProgramId, 'Candidate'), createParams(publicProgramId));
             expect(res.status).toBe(200);
             
             const data = await res.json();
             // Should fetch nonMember, activeMember, and householdMember, but NOT alreadyEnrolled
             const names = data.members.map((m: { id?: number; email?: string; name?: string; participantId?: number; level?: string; status?: string; role?: string; type?: string; [key: string]: unknown }) => m.name);
             
             expect(names).toContain('Active Member Candidate');
             expect(names).toContain('Household Member Candidate');
             expect(names).toContain('Non Member Candidate');
             expect(names).not.toContain('Already Enrolled Candidate');
        });

        it('should filter candidates by query string via name', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

             const res = await GET(createReq(publicProgramId, 'Active'), createParams(publicProgramId));
             expect(res.status).toBe(200);
             
             const data = await res.json();
             expect(data.members.length).toBe(1);
             expect(data.members[0].name).toBe('Active Member Candidate');
        });

        it('should filter candidates by query string via email', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

             const res = await GET(createReq(publicProgramId, 'non-member-elig'), createParams(publicProgramId));
             expect(res.status).toBe(200);
             
             const data = await res.json();
             expect(data.members.length).toBe(1);
             expect(data.members[0].name).toBe('Non Member Candidate');
        });

        it('should strictly limit candidates for orgMemberOnly programs to members and household members', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });

             const res = await GET(createReq(orgMemberOnlyProgramId, 'Candidate'), createParams(orgMemberOnlyProgramId));
             expect(res.status).toBe(200);
             
             const data = await res.json();
             const names = data.members.map((m: { id?: number; email?: string; name?: string; participantId?: number; level?: string; status?: string; role?: string; type?: string; [key: string]: unknown }) => m.name);
             
             expect(names).toContain('Active Member Candidate'); // Individual member
             expect(names).toContain('Household Member Candidate'); // Under household member
             
             // The non-member should be excluded entirely
             expect(names).not.toContain('Non Member Candidate');
        });
    });
});
