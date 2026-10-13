/**
 * @jest-environment node
 */
/**
 * Integration Tests for Program Participants API
 * Tests POST and DELETE /api/programs/[id]/participants for enrollments
 */

import { POST, DELETE } from '@/app/api/programs/[id]/participants/route';
import prisma from '@/lib/prisma';
import { withdrawAndReleaseHold } from '@/lib/program/capacity';
import { getServerSession } from 'next-auth/next';
// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));
// Mock Notifications
jest.mock('@/lib/notifications', () => ({
    sendNotification: jest.fn()
}));

describe('Program Participants API Integration Tests', () => {
    let adminId: number;
    let leadId: number;
    let commonId: number;
    let otherId: number;
    let boardId: number;   // board member who leads a household
    let depId: number;     // dependent (25yo) in the board member's household
    let youthDepId: number; // youth dependent in the same household
    let boardNonLeadId: number; // board member in that household who is NOT its lead
    let dep2Id: number;    // second dependent (25yo) in the same household
    let memberId: number;  // person in a household with an ACTIVE OrgMembership
    let memberHouseholdId: number;

    let standardProgramId: number;
    let freeProgramId: number;
    let fullProgramId: number;
    let exactAgeProgramId: number;
    let memberOnlyProgramId: number;

    beforeAll(async () => {
        // Clean up any leaked state
        const existingUsers = await prisma.person.findMany({
            where: { email: { contains: 'partic-api-test' } },
            select: { id: true }
        });
        const existingUserIds = existingUsers.map(u => u.id);

        await prisma.programParticipant.deleteMany({
            where: { personId: { in: existingUserIds } }
        });

        await prisma.orgMembership.deleteMany({
            where: { household: { householdMembers: { some: { id: { in: existingUserIds } } } } }
        });

        await prisma.program.deleteMany({
            where: { name: { contains: 'Partic API Test' } }
        });
        
        await prisma.auditLog.deleteMany({
            where: { actorId: { in: existingUserIds } }
        });
        
        await prisma.person.deleteMany({
            where: { id: { in: existingUserIds } }
        });

        // Create Admin
        const admin = await prisma.person.create({
            // Adult DOB: this persona self-enrolls in the conflict-of-interest
            // capacity test, which must reach the capacity limit rather than stop
            // at the known-adult self-gate.
            data: {
                email: 'admin-partic-api-test@example.com',
                name: 'Admin',
                isSysadmin: true,
                dateOfBirth: new Date(Date.now() - (35 * 31556952000)),
                household: { create: { name: "Test HH" } },
            }
        });
        adminId = admin.id;

        // Create Lead
        const lead = await prisma.person.create({
            // Adult DOB: this persona self-enrolls in the double-submit test below.
            data: {
                email: 'lead-partic-api-test@example.com',
                name: 'Lead',
                dateOfBirth: new Date(Date.now() - (30 * 31556952000)),
                household: { create: { name: "Test HH" } },
            }
        });
        leadId = lead.id;

        // Create Common User (25 years old)
        const commonUser = await prisma.person.create({
            data: {
                email: 'common-partic-api-test@example.com',
                name: 'Common',
                dateOfBirth: new Date(Date.now() - (25 * 31556952000)),
                household: { create: { name: "Test HH" } }
            }
        });
        commonId = commonUser.id;

        // Create Other User (underage: 10 years old)
        const otherUser = await prisma.person.create({
            data: {
                email: 'other-partic-api-test@example.com',
                name: 'Other Underage',
                dateOfBirth: new Date(Date.now() - (10 * 31556952000)),
                household: { create: { name: "Test HH" } }
            }
        });
        otherId = otherUser.id;

        // Board member who leads a household containing a 25yo dependent. The
        // board flag lives on the session, not the DB row — see the mocks below.
        const boardHousehold = await prisma.household.create({ data: { name: "Test HH" } });
        const board = await prisma.person.create({
            data: { email: 'board-partic-api-test@example.com', name: 'Board Parent', householdId: boardHousehold.id }
        });
        boardId = board.id;
        const dependent = await prisma.person.create({
            data: {
                email: 'dep-partic-api-test@example.com',
                name: 'Board Dependent',
                dateOfBirth: new Date(Date.now() - (25 * 31556952000)),
                householdId: boardHousehold.id
            }
        });
        depId = dependent.id;
        const youthDependent = await prisma.person.create({
            data: {
                email: 'youthdep-partic-api-test@example.com',
                name: 'Board Youth Dependent',
                dateOfBirth: new Date(Date.now() - (10 * 31556952000)),
                householdId: boardHousehold.id
            }
        });
        youthDepId = youthDependent.id;
        await prisma.person.update({
            where: { id: boardId },
            data: { isHouseholdLead: true, dateOfBirth: new Date(Date.now() - (40 * 31556952000)) }
        });

        // Same household, board flag, but NOT the lead — the case `isHouseholdLead`
        // alone misses. Plus a second dependent so this actor has an own-household
        // target that no other test has already enrolled.
        const boardNonLead = await prisma.person.create({
            data: { email: 'board-nonlead-partic-api-test@example.com', name: 'Board Non-Lead', householdId: boardHousehold.id }
        });
        boardNonLeadId = boardNonLead.id;
        const dependent2 = await prisma.person.create({
            data: {
                email: 'dep2-partic-api-test@example.com',
                name: 'Board Dependent Two',
                dateOfBirth: new Date(Date.now() - (25 * 31556952000)),
                householdId: boardHousehold.id
            }
        });
        dep2Id = dependent2.id;

        // Create mock programs
        const standardProgram = await prisma.program.create({
            // Priced programs carry a variant — a priced one without it is
            // checkout-broken and the route now refuses payment-bound enrollment.
            data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Standard Partic API Test', phase: 'RUNNING', enrollmentStatus: 'OPEN', leadMentorId: leadId, orgMemberPriceCents: 1000, nonOrgMemberPriceCents: 1500, shopifyVariantId: 'dev-mock-variant-standard-partic' }
        });
        standardProgramId = standardProgram.id;

        const freeProgram = await prisma.program.create({
            data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Free Partic API Test', phase: 'RUNNING', enrollmentStatus: 'OPEN', leadMentorId: leadId, orgMemberPriceCents: null, nonOrgMemberPriceCents: null }
        });
        freeProgramId = freeProgram.id;

        // Create a capped program and pre-fill it to its capacity (1 participant)
        const fullProgram = await prisma.program.create({
            data: { 
                startAt: new Date('2026-01-01'),
                endAt: new Date('2026-12-31'),
                name: 'Full Partic API Test', 
                phase: 'RUNNING', 
                enrollmentStatus: 'OPEN',
                maxParticipants: 1,
                participants: {
                    create: { personId: otherId }
                }
            }
        });
        fullProgramId = fullProgram.id;

        const exactAgeProgram = await prisma.program.create({
            data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Age Restricted Partic API Test', phase: 'RUNNING', enrollmentStatus: 'OPEN', minAge: 18, maxAge: 21 }
        });
        exactAgeProgramId = exactAgeProgram.id;

        // Treehouse Member (household carries the ACTIVE OrgMembership) + the
        // members-only program they are the only eligible enroller for.
        const memberHousehold = await prisma.household.create({
            data: { name: "Test HH", orgMembership: { create: { status: 'ACTIVE' } } }
        });
        memberHouseholdId = memberHousehold.id;
        const member = await prisma.person.create({
            data: {
                email: 'member-partic-api-test@example.com',
                name: 'Org Member',
                dateOfBirth: new Date(Date.now() - (25 * 31556952000)),
                householdId: memberHouseholdId
            }
        });
        memberId = member.id;

        const memberOnlyProgram = await prisma.program.create({
            data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Member Only Partic API Test', phase: 'RUNNING', enrollmentStatus: 'OPEN', orgMemberOnly: true, orgMemberPriceCents: null, nonOrgMemberPriceCents: null }
        });
        memberOnlyProgramId = memberOnlyProgram.id;
    });

    afterAll(async () => {
        const existingUserIds = [adminId, leadId, commonId, otherId, boardId, depId, youthDepId, boardNonLeadId, dep2Id, memberId].filter(id => id !== undefined);
        const validProgramIds = [standardProgramId, freeProgramId, fullProgramId, exactAgeProgramId, memberOnlyProgramId].filter(id => id !== undefined);

        if (existingUserIds.length > 0) {
            await prisma.programParticipant.deleteMany({
                where: { personId: { in: existingUserIds } }
            });
        }

        if (validProgramIds.length > 0) {
            await prisma.program.deleteMany({
                where: { id: { in: validProgramIds } }
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

        if (memberHouseholdId !== undefined) {
            await prisma.orgMembership.deleteMany({ where: { householdId: memberHouseholdId } });
        }
    });

    const createParams = (id: number) => ({ params: Promise.resolve({ id: id.toString() }) });

    describe('POST /api/programs/[id]/participants', () => {
        it('should return 401 Unauthorized without session', async () => {
             (getServerSession as jest.Mock).mockResolvedValue(null);

             const req = new Request(`http://localhost:4000/api/programs/${standardProgramId}/participants`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: commonId })
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(standardProgramId) as unknown as never);
             expect(res.status).toBe(401);
        });

        it('should block a common user from enrolling someone else', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } });

             const req = new Request(`http://localhost:4000/api/programs/${standardProgramId}/participants`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: otherId }) // common trying to enroll other
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(standardProgramId) as unknown as never);
             expect(res.status).toBe(403);
             
             const data = await res.json();
             expect(data.error).toMatch(/Forbidden/);
        });

        it('should allow a common user to self-enroll into a paid program as PENDING', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } });

             const req = new Request(`http://localhost:4000/api/programs/${standardProgramId}/participants`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: commonId }) // self-enrollment
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(standardProgramId) as unknown as never);
             expect(res.status).toBe(200);
             
             const data = await res.json();
             expect(data.success).toBe(true);
             expect(data.enrollment.personId).toBe(commonId);
             expect(data.enrollment.status).toBe('PENDING');
        });

        it('should allow a common user to self-enroll into a free program as ACTIVE', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } });

             const req = new Request(`http://localhost:4000/api/programs/${freeProgramId}/participants`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: commonId }) // self-enrollment
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(freeProgramId) as unknown as never);
             expect(res.status).toBe(200);
             
             const data = await res.json();
             expect(data.success).toBe(true);
             expect(data.enrollment.personId).toBe(commonId);
             expect(data.enrollment.status).toBe('ACTIVE');
        });

        it('should block self-enrollment if the program is at full capacity', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } });

             const req = new Request(`http://localhost:4000/api/programs/${fullProgramId}/participants`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: commonId })
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(fullProgramId) as unknown as never);
             expect(res.status).toBe(400); // 400 Bad Request
             
             const data = await res.json();
             expect(data.error).toMatch(/maximum capacity/);
             expect(data.requiresOverride).toBe(true);
        });

        it('should block self-enrollment if out of age constraints', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: otherId } }); // other is 10 years old

             const req = new Request(`http://localhost:4000/api/programs/${exactAgeProgramId}/participants`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: otherId })
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(exactAgeProgramId) as unknown as never);
             expect(res.status).toBe(400);
             
             const data = await res.json();
             expect(data.error).toMatch(/at least 18/);
             expect(data.requiresOverride).toBe(true);
        });

        it('should allow admins to bypass age constraints using override', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

             const req = new Request(`http://localhost:4000/api/programs/${exactAgeProgramId}/participants`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: otherId, override: true }) // ignoring age rules
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(exactAgeProgramId) as unknown as never);
             expect(res.status).toBe(200);

             const data = await res.json();
             expect(data.success).toBe(true);
        });

        // INTENT LOCK: a board/isSysadmin override DELIBERATELY overfills a program
        // past maxParticipants FOR SOMEONE ELSE. The override is a confirmed action
        // (the route first returns requiresOverride:true) and is meant to bypass
        // every soft limit — closed enrollment, age, AND capacity. This 200 is
        // correct, not a bug. The non-override path still cannot overbook (see the
        // 400 test above and programsParticipantsConcurrency.integration.test.ts),
        // and a conflicted actor cannot bypass at all (see the two tests below).
        // Do not "fix" the capacity bypass at route.ts enforceLimits to make this
        // fail — narrow it only to the conflicted case.
        it('should allow an admin override to enroll a non-household person into a FULL program (deliberate overfill)', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

             const req = new Request(`http://localhost:4000/api/programs/${fullProgramId}/participants`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: commonId, override: true })
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(fullProgramId) as unknown as never);
             expect(res.status).toBe(200);

             const data = await res.json();
             expect(data.success).toBe(true);
             expect(data.enrollment.status).toBe('ACTIVE'); // override → confirmed comp

             // Program is now intentionally over its cap of 1.
             const enrolled = await prisma.programParticipant.count({ where: { programId: fullProgramId } });
             expect(enrolled).toBe(2);
        });

        // Conflict of interest: the override is a one-actor decision, so it cannot
        // be spent on the actor's own seat. A sysadmin self-enrolling into a FULL
        // program falls through to the ordinary enforced-limits path.
        it('should NOT let a sysadmin override the capacity limit for their OWN enrollment', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

             const req = new Request(`http://localhost:4000/api/programs/${fullProgramId}/participants`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: adminId, override: true })
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(fullProgramId) as unknown as never);
             expect(res.status).toBe(400);

             const data = await res.json();
             expect(data.error).toMatch(/maximum capacity/);
             expect(data.requiresOverride).toBe(true);

             const row = await prisma.programParticipant.findUnique({
                 where: { programId_personId: { programId: fullProgramId, personId: adminId } },
             });
             expect(row).toBeNull();
        });

        // Same rule one step out: own household is the actor's own interest too.
        it('should NOT let a board member override the age limit for their OWN household member', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

             // depId is 25 — outside the exact-age program's [18, 21] band.
             const req = new Request(`http://localhost:4000/api/programs/${exactAgeProgramId}/participants`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: depId, override: true })
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(exactAgeProgramId) as unknown as never);
             expect(res.status).toBe(400);

             const data = await res.json();
             expect(data.error).toMatch(/maximum age is 21/);
             expect(data.requiresOverride).toBe(true);

             const row = await prisma.programParticipant.findUnique({
                 where: { programId_personId: { programId: exactAgeProgramId, personId: depId } },
             });
             expect(row).toBeNull();
        });

        // A board member is also a parent. Enrolling their own dependent through
        // the public program page must behave like any household lead: PENDING
        // (awaiting Shopify payment), NOT a comped/free enrollment and NOT a
        // scary "bypasses all payment" override prompt.
        it('should make a board parent PAY (PENDING) when enrolling their own dependent in a paid program', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

             const req = new Request(`http://localhost:4000/api/programs/${standardProgramId}/participants`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: depId }) // no override
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(standardProgramId) as unknown as never);
             expect(res.status).toBe(200);

             const data = await res.json();
             expect(data.success).toBe(true);
             expect(data.enrollment.status).toBe('PENDING'); // pays like any parent
        });

        // "Own household" for the comp is shared-household, not lead-of-household:
        // a board member who is an ordinary (non-lead) member of the household pays
        // for their own household member too, and cannot buy the comp with an
        // override.
        it('should make a NON-LEAD board household member PAY (PENDING) for their own household member', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardNonLeadId, isBoardMember: true } });

             const req = new Request(`http://localhost:4000/api/programs/${standardProgramId}/participants`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: dep2Id, override: true })
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(standardProgramId) as unknown as never);
             expect(res.status).toBe(200);

             const data = await res.json();
             expect(data.enrollment.status).toBe('PENDING'); // not a comp
        });

        // The comp still belongs to genuine admin action: a board member
        // enrolling someone OUTSIDE their household (the program-ops surface).
        it('should require override + comp (ACTIVE) when a board member enrolls a non-household participant', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

             const promptReq = new Request(`http://localhost:4000/api/programs/${standardProgramId}/participants`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: otherId }) // not in board's household, no override
             });
             const promptRes = await POST(promptReq as unknown as import("next/server").NextRequest, createParams(standardProgramId) as unknown as never);
             expect(promptRes.status).toBe(400);
             expect((await promptRes.json()).requiresOverride).toBe(true);

             const forceReq = new Request(`http://localhost:4000/api/programs/${standardProgramId}/participants`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: otherId, override: true })
             });
             const forceRes = await POST(forceReq as unknown as import("next/server").NextRequest, createParams(standardProgramId) as unknown as never);
             expect(forceRes.status).toBe(200);
             expect((await forceRes.json()).enrollment.status).toBe('ACTIVE'); // admin comp
        });

        // A board/sysadmin comp seats a participant with NO Shopify
        // checkout, so unlike a paid PENDING enrollment nothing ever fires
        // Shopify's own sale-time -1. The comp path must reconcile it (-1),
        // exactly like a paid sale and like scholarship apply — else the
        // storefront keeps showing the taken seat as available (oversell).
        it('comp-add decrements Shopify inventory (-1) for a capped Shopify program', async () => {
            const prevCheckinEnv = process.env.CHECKIN_ENV;
            process.env.CHECKIN_ENV = 'local'; // arms the adjustProgramInventory mock (logs the delta)
            const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const shopifyProgram = await prisma.program.create({
                data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Comp Shopify Partic API Test', enrollmentStatus: 'OPEN', maxParticipants: 5, orgMemberPriceCents: 1000, shopifyVariantId: 'dev-mock-variant-comp-partic' },
            });
            try {
                (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });
                const res = await POST(
                    // CHECKIN_ENV=local arms the keyless-kiosk fallback — send a cookie so
                    // the request isn't hijacked as `kiosk` before the session gate runs.
                    new Request(`http://localhost:4000/api/programs/${shopifyProgram.id}/participants`, {
                        method: 'POST',
                        headers: { cookie: 'session=test' },
                        body: JSON.stringify({ participantId: otherId, override: true }), // external admin comp
                    }) as unknown as import("next/server").NextRequest,
                    createParams(shopifyProgram.id) as unknown as never,
                );
                expect(res.status).toBe(200);
                const data = await res.json();
                expect(data.enrollment.status).toBe('ACTIVE'); // comp
                expect(data.warning).toBeUndefined();
                // The comp took a seat out of the Shopify pool: relative -1 on the variant.
                expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Would adjust inventory by -1 for variant: dev-mock-variant-comp-partic'));
                // Comp is ACTIVE and NOT a hold: I1/I2/I3 keep inventoryHeldAt PENDING-only.
                const row = await prisma.programParticipant.findUnique({
                    where: { programId_personId: { programId: shopifyProgram.id, personId: otherId } },
                });
                expect(row?.inventoryHeldAt).toBeNull();
            } finally {
                logSpy.mockRestore();
                process.env.CHECKIN_ENV = prevCheckinEnv;
                await prisma.programParticipant.deleteMany({ where: { programId: shopifyProgram.id } });
                await prisma.program.delete({ where: { id: shopifyProgram.id } });
            }
        });

        // Mirror the scholarship / cap-edit Shopify-failure discipline: the DB
        // change stands, the failure is surfaced as a warning (adjustProgramInventory
        // has already logged + emailed sysadmins), and the board reconciles. A comp
        // that half-commits (enrollment rolled back) would be worse than the original gap.
        //
        // Real failure, no mock: with the Shopify mock OFF (env not `local`) and no
        // SHOPIFY_STORE_DOMAIN/credentials configured, adjustProgramInventory returns
        // false at its credential guard (before any network) — the exact non-fatal
        // failure the warning branch handles.
        it('comp-add keeps the enrollment and warns when the Shopify decrement fails', async () => {
            const prevCheckinEnv = process.env.CHECKIN_ENV;
            const prevDomain = process.env.SHOPIFY_STORE_DOMAIN;
            delete process.env.CHECKIN_ENV;       // mock off → real adjust path
            delete process.env.SHOPIFY_STORE_DOMAIN; // no creds → returns false (no network)
            const shopifyProgram = await prisma.program.create({
                data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Comp Shopify Fail Partic API Test', enrollmentStatus: 'OPEN', maxParticipants: 5, orgMemberPriceCents: 1000, shopifyVariantId: 'dev-mock-variant-comp-fail' },
            });
            try {
                (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });
                const res = await POST(
                    new Request(`http://localhost:4000/api/programs/${shopifyProgram.id}/participants`, {
                        method: 'POST',
                        body: JSON.stringify({ participantId: otherId, override: true }),
                    }) as unknown as import("next/server").NextRequest,
                    createParams(shopifyProgram.id) as unknown as never,
                );
                expect(res.status).toBe(200);
                expect((await res.json()).warning).toMatch(/out of sync/i);
                // No half-commit: the comp enrollment still exists (ACTIVE).
                const row = await prisma.programParticipant.findUnique({
                    where: { programId_personId: { programId: shopifyProgram.id, personId: otherId } },
                });
                expect(row?.status).toBe('ACTIVE');
            } finally {
                process.env.CHECKIN_ENV = prevCheckinEnv;
                if (prevDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
                else process.env.SHOPIFY_STORE_DOMAIN = prevDomain;
                await prisma.programParticipant.deleteMany({ where: { programId: shopifyProgram.id } });
                await prisma.program.delete({ where: { id: shopifyProgram.id } });
            }
        });

        // The three read routes only HIDE an orgMemberOnly program; POSTing the id
        // directly used to enroll a non-member outright.
        it('should block a non-member from self-enrolling into a members-only program', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } });

             const req = new Request(`http://localhost:4000/api/programs/${memberOnlyProgramId}/participants`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: commonId })
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(memberOnlyProgramId) as unknown as never);
             expect(res.status).toBe(400);

             const data = await res.json();
             expect(data.error).toMatch(/Treehouse Members only/);
             expect(data.requiresOverride).toBe(true);

             const row = await prisma.programParticipant.findUnique({
                 where: { programId_personId: { programId: memberOnlyProgramId, personId: commonId } },
             });
             expect(row).toBeNull();
        });

        it('should allow a Treehouse Member to self-enroll into a members-only program', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: memberId } });

             const req = new Request(`http://localhost:4000/api/programs/${memberOnlyProgramId}/participants`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: memberId })
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(memberOnlyProgramId) as unknown as never);
             expect(res.status).toBe(200);

             const data = await res.json();
             expect(data.success).toBe(true);
             expect(data.enrollment.personId).toBe(memberId);
        });

        // #1397: the write gate must admit exactly who the read gates show the
        // program to — a household whose dues are paid and whose background check
        // is still with the board sees this program, so it must be able to enroll.
        it('should allow a household that has paid but is awaiting background clearance', async () => {
             const paidPending = await prisma.person.create({
                 data: {
                     email: 'paid-pending-partic-api-test@example.com',
                     name: 'Paid Pending',
                     dateOfBirth: new Date('1990-01-01'),
                     household: {
                         create: {
                             name: 'Test HH',
                             orgMembership: {
                                 create: {
                                     status: 'NONE',
                                     processes: { create: { kind: 'INITIAL', status: 'PENDING_BG_CLEARANCE', paidAt: new Date() } },
                                 },
                             },
                         },
                     },
                 },
                 select: { id: true, householdId: true },
             });

             try {
                 (getServerSession as jest.Mock).mockResolvedValue({ user: { id: paidPending.id } });

                 const req = new Request(`http://localhost:4000/api/programs/${memberOnlyProgramId}/participants`, {
                     method: 'POST',
                     body: JSON.stringify({ participantId: paidPending.id })
                 });
                 const res = await POST(req as unknown as import("next/server").NextRequest, createParams(memberOnlyProgramId) as unknown as never);
                 expect(res.status).toBe(200);

                 const data = await res.json();
                 expect(data.success).toBe(true);
             } finally {
                 await prisma.programParticipant.deleteMany({ where: { personId: paidPending.id } });
                 await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: paidPending.householdId } } });
                 await prisma.orgMembership.deleteMany({ where: { householdId: paidPending.householdId } });
                 await prisma.person.delete({ where: { id: paidPending.id } });
             }
        });

        // The members-only gate lives inside enforceLimits, so it must not break
        // the deliberate comp path — a confirmed board/sysadmin override still
        // seats a non-member.
        it('should let a confirmed admin comp a non-member into a members-only program', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

             const req = new Request(`http://localhost:4000/api/programs/${memberOnlyProgramId}/participants`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: otherId, override: true })
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(memberOnlyProgramId) as unknown as never);
             expect(res.status).toBe(200);

             const data = await res.json();
             expect(data.success).toBe(true);
             expect(data.enrollment.status).toBe('ACTIVE');
        });

        // Only a KNOWN adult may commit themselves. A youth needs a household
        // lead; an unverifiable age is refused too and routed to age capture.
        it('should block a youth from self-enrolling, even into a free program', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: otherId } }); // 10 years old

             const req = new Request(`http://localhost:4000/api/programs/${freeProgramId}/participants`, {
                 method: 'POST',
                 body: JSON.stringify({ participantId: otherId })
             });
             const res = await POST(req as unknown as import("next/server").NextRequest, createParams(freeProgramId) as unknown as never);
             expect(res.status).toBe(403);
             expect((await res.json()).error).toMatch(/household lead must enroll/i);

             const row = await prisma.programParticipant.findUnique({
                 where: { programId_personId: { programId: freeProgramId, personId: otherId } },
             });
             expect(row).toBeNull();
        });

        it('should block a self-enroller whose age is unverifiable, pointing them at age capture', async () => {
             const noAge = await prisma.person.create({
                 data: { email: 'noage-partic-api-test@example.com', name: 'No Age', household: { create: { name: "Test HH" } } }
             });
             try {
                 (getServerSession as jest.Mock).mockResolvedValue({ user: { id: noAge.id } });

                 const res = await POST(
                     new Request(`http://localhost:4000/api/programs/${freeProgramId}/participants`, {
                         method: 'POST',
                         body: JSON.stringify({ participantId: noAge.id })
                     }) as unknown as import("next/server").NextRequest,
                     createParams(freeProgramId) as unknown as never,
                 );
                 expect(res.status).toBe(403);
                 // Not the lead-required message: the remedy is to establish an age.
                 expect((await res.json()).error).toMatch(/date of birth|over 25/i);
             } finally {
                 await prisma.programParticipant.deleteMany({ where: { personId: noAge.id } });
                 await prisma.person.delete({ where: { id: noAge.id } });
                 await prisma.household.deleteMany({ where: { householdMembers: { none: {} }, name: "Test HH" } });
             }
        });

        // The gate is about who INITIATES: a lead enrolling their own child is
        // the supported path and must keep working.
        it('should let a household lead enroll a youth in their household', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId } }); // lead, no board flag on the session

             const res = await POST(
                 new Request(`http://localhost:4000/api/programs/${freeProgramId}/participants`, {
                     method: 'POST',
                     body: JSON.stringify({ participantId: youthDepId })
                 }) as unknown as import("next/server").NextRequest,
                 createParams(freeProgramId) as unknown as never,
             );
             expect(res.status).toBe(200);
             expect((await res.json()).enrollment.personId).toBe(youthDepId);
        });

        it('should return 409 (not 500) when enrolling the same participant twice', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });

             const enroll = () => POST(
                 new Request(`http://localhost:4000/api/programs/${freeProgramId}/participants`, {
                     method: 'POST',
                     body: JSON.stringify({ participantId: leadId }) // self-enroll into free program
                 }) as unknown as import("next/server").NextRequest,
                 createParams(freeProgramId) as unknown as never
             );

             const first = await enroll();
             expect(first.status).toBe(200);

             // Double-submit (UI double-click) — must be a clean 409, not a 500.
             const second = await enroll();
             expect(second.status).toBe(409);
             const data = await second.json();
             expect(data.error).toMatch(/already enrolled/i);

             // No duplicate row, no corruption: exactly one enrollment exists.
             const count = await prisma.programParticipant.count({
                 where: { programId: freeProgramId, personId: leadId }
             });
             expect(count).toBe(1);
        });

        it('lets a family with a PENDING claim back to checkout (409) even once the program is full, closed and finished', async () => {
             const program = await prisma.program.create({
                 data: {
                     startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Pending Claim Partic API Test',
                     phase: 'FINISHED', enrollmentStatus: 'CLOSED', maxParticipants: 1,
                     orgMemberPriceCents: 1000, nonOrgMemberPriceCents: 1500, shopifyVariantId: 'dev-mock-variant-pending-claim',
                     participants: { create: { personId: commonId, status: 'PENDING' } },
                 },
             });
             try {
                 (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } });
                 const res = await POST(
                     new Request(`http://localhost:4000/api/programs/${program.id}/participants`, {
                         method: 'POST',
                         body: JSON.stringify({ participantId: commonId })
                     }) as unknown as import("next/server").NextRequest,
                     createParams(program.id) as unknown as never
                 );
                 expect(res.status).toBe(409);
                 expect((await res.json()).error).toMatch(/already enrolled/i);
                 expect(await prisma.programParticipant.count({ where: { programId: program.id } })).toBe(1);
             } finally {
                 await prisma.programParticipant.deleteMany({ where: { programId: program.id } });
                 await prisma.program.delete({ where: { id: program.id } });
             }
        });
    });

    describe('DELETE /api/programs/[id]/participants', () => {
        it('should return 401 Unauthorized without session', async () => {
             (getServerSession as jest.Mock).mockResolvedValue(null);

             const req = new Request(`http://localhost:4000/api/programs/${standardProgramId}/participants`, {
                 method: 'DELETE',
                 body: JSON.stringify({ participantId: commonId })
             });
             const res = await DELETE(req as unknown as import("next/server").NextRequest, createParams(standardProgramId) as unknown as never);
             expect(res.status).toBe(401);
        });

        it('should block a common user from un-enrolling someone else', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } });

             const req = new Request(`http://localhost:4000/api/programs/${exactAgeProgramId}/participants`, {
                 method: 'DELETE',
                 body: JSON.stringify({ participantId: otherId })
             });
             const res = await DELETE(req as unknown as import("next/server").NextRequest, createParams(exactAgeProgramId) as unknown as never);
             expect(res.status).toBe(403);
             
             const data = await res.json();
             expect(data.error).toMatch(/Forbidden/);
        });

        it('should allow the program lead to un-enroll a participant', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });

             const req = new Request(`http://localhost:4000/api/programs/${standardProgramId}/participants`, {
                 method: 'DELETE',
                 body: JSON.stringify({ participantId: commonId }) // assigned lead removing common from standardProgram
             });
             const res = await DELETE(req as unknown as import("next/server").NextRequest, createParams(standardProgramId) as unknown as never);
             expect(res.status).toBe(200);

             const data = await res.json();
             expect(data.success).toBe(true);
             // The response must NOT echo the deleted row: it reaches the lead
             // mentor and carries confidential hardship fields (see #930 review).
             expect(data.enrollment).toBeUndefined();
             const row = await prisma.programParticipant.findUnique({
                 where: { programId_personId: { programId: standardProgramId, personId: commonId } },
             });
             expect(row).toBeNull();
        });
        
        // A youth may not withdraw themselves: beyond matching the enroll gate,
        // withdrawing a scholarship-held seat releases Shopify inventory, a
        // financial side effect that is the household lead's to trigger.
        it('should block a youth from dropping out of their own program', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: otherId } }); // 10 years old

             const req = new Request(`http://localhost:4000/api/programs/${fullProgramId}/participants`, {
                 method: 'DELETE',
                 body: JSON.stringify({ participantId: otherId })
             });
             const res = await DELETE(req as unknown as import("next/server").NextRequest, createParams(fullProgramId) as unknown as never);
             expect(res.status).toBe(403);
             expect((await res.json()).error).toMatch(/household lead must withdraw/i);

             // Still enrolled — the refusal wrote nothing.
             const row = await prisma.programParticipant.findUnique({
                 where: { programId_personId: { programId: fullProgramId, personId: otherId } },
             });
             expect(row).not.toBeNull();
        });

        it('should allow an adult to drop out of their own program', async () => {
             // An earlier POST test may already have seated them; make the fixture
             // independent of test order.
             await prisma.programParticipant.upsert({
                 where: { programId_personId: { programId: freeProgramId, personId: commonId } },
                 create: { programId: freeProgramId, personId: commonId, status: 'ACTIVE' },
                 update: { status: 'ACTIVE' },
             });
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } });

             const req = new Request(`http://localhost:4000/api/programs/${freeProgramId}/participants`, {
                 method: 'DELETE',
                 body: JSON.stringify({ participantId: commonId }) // self-removal
             });
             const res = await DELETE(req as unknown as import("next/server").NextRequest, createParams(freeProgramId) as unknown as never);
             expect(res.status).toBe(200);

             const data = await res.json();
             expect(data.success).toBe(true);
        });

        it('should be idempotent (200, not 500) when un-enrolling a participant twice', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } });

             // commonId already self-removed from freeProgram in the test above.
             // A second delete hits a missing row (Prisma P2025) — must stay 200.
             const req = new Request(`http://localhost:4000/api/programs/${freeProgramId}/participants`, {
                 method: 'DELETE',
                 body: JSON.stringify({ participantId: commonId })
             });
             const res = await DELETE(req as unknown as import("next/server").NextRequest, createParams(freeProgramId) as unknown as never);
             expect(res.status).toBe(200);
             const data = await res.json();
             expect(data.success).toBe(true);
        });

        // Hold-ledger (product decision 2026-07-06): withdrawal is release path
        // (a) — a denied applicant who withdraws instead of paying gets their
        // held seat back, exactly once (double-withdraw is the existing
        // idempotent no-op above, and must not fire a second +1).
        it('releases a held scholarship seat back to Shopify (+1) on withdrawal, exactly once', async () => {
            const prevCheckinEnv = process.env.CHECKIN_ENV;
            process.env.CHECKIN_ENV = 'local';
            const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const shopifyProgram = await prisma.program.create({
                data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Withdraw Shopify Partic API Test', enrollmentStatus: 'OPEN', shopifyVariantId: 'dev-mock-variant-withdraw-partic' },
            });
            try {
                await prisma.programParticipant.create({
                    data: {
                        programId: shopifyProgram.id,
                        personId: commonId,
                        status: 'PENDING',
                        isPaymentPlanRequested: false,
                        inventoryHeldAt: new Date(),
                        paymentPlanDeniedAt: new Date(),
                    },
                });
                (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } }); // self-withdraw

                const res = await DELETE(
                    // CHECKIN_ENV=local arms the keyless-kiosk fallback in
                    // authenticateRequest, which hijacks any cookie-less request as
                    // `kiosk` -> 403 before the session/role gate runs — send a cookie.
                    new Request(`http://localhost:4000/api/programs/${shopifyProgram.id}/participants`, {
                        method: 'DELETE',
                        headers: { cookie: 'session=test' },
                        body: JSON.stringify({ participantId: commonId }),
                    }) as unknown as import("next/server").NextRequest,
                    createParams(shopifyProgram.id) as unknown as never,
                );
                expect(res.status).toBe(200);
                const withdrawData = await res.json();
                expect(withdrawData.warning).toBeUndefined();
                // Scholarship release path already fires +1; it is
                // NOT the manual-restock notice case.
                expect(withdrawData.notice).toBeUndefined();
                expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Would adjust inventory by 1 for variant: dev-mock-variant-withdraw-partic'));

                const row = await prisma.programParticipant.findUnique({
                    where: { programId_personId: { programId: shopifyProgram.id, personId: commonId } },
                });
                expect(row).toBeNull();

                // Double-withdraw: idempotent 200 (P2025), no second +1.
                logSpy.mockClear();
                const second = await DELETE(
                    // CHECKIN_ENV=local arms the keyless-kiosk fallback in
                    // authenticateRequest, which hijacks any cookie-less request as
                    // `kiosk` -> 403 before the session/role gate runs — send a cookie.
                    new Request(`http://localhost:4000/api/programs/${shopifyProgram.id}/participants`, {
                        method: 'DELETE',
                        headers: { cookie: 'session=test' },
                        body: JSON.stringify({ participantId: commonId }),
                    }) as unknown as import("next/server").NextRequest,
                    createParams(shopifyProgram.id) as unknown as never,
                );
                expect(second.status).toBe(200);
                expect((await second.json()).idempotent).toBe(true);
                expect(logSpy).not.toHaveBeenCalled();
            } finally {
                logSpy.mockRestore();
                process.env.CHECKIN_ENV = prevCheckinEnv;
                await prisma.programParticipant.deleteMany({ where: { programId: shopifyProgram.id } });
                await prisma.program.delete({ where: { id: shopifyProgram.id } });
            }
        });

        // Removing an ACTIVE seat frees the room but does NOT auto-restock
        // Shopify (paid/comped seats are only put back on sale by a human). The
        // route returns an advisory `notice` and fires NO +1 — the staffer
        // decides whether to restock. Staff-only (#1519): only sysadmin/board
        // can actually act on the notice in Shopify.
        it('advises (notice) on ACTIVE removal from a capped Shopify program when staff removes, and does NOT +1', async () => {
            const prevCheckinEnv = process.env.CHECKIN_ENV;
            process.env.CHECKIN_ENV = 'local'; // arms the adjustProgramInventory mock (logs the delta)
            const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const shopifyProgram = await prisma.program.create({
                data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Notice Shopify Partic API Test', enrollmentStatus: 'OPEN', maxParticipants: 5, shopifyVariantId: 'dev-mock-variant-notice-partic' },
            });
            try {
                await prisma.programParticipant.create({
                    data: { programId: shopifyProgram.id, personId: commonId, status: 'ACTIVE' },
                });
                (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } }); // staff removal

                const res = await DELETE(
                    new Request(`http://localhost:4000/api/programs/${shopifyProgram.id}/participants`, {
                        method: 'DELETE',
                        headers: { cookie: 'session=test' },
                        body: JSON.stringify({ participantId: commonId }),
                    }) as unknown as import("next/server").NextRequest,
                    createParams(shopifyProgram.id) as unknown as never,
                );
                expect(res.status).toBe(200);
                const data = await res.json();
                expect(data.notice).toMatch(/NOT put back on sale automatically/i);
                expect(data.warning).toBeUndefined();
                // Freed seat is NOT auto-restocked: no positive-delta Shopify call.
                expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Would adjust inventory by 1'));
                // Seat-freeing itself is unaffected by who removed it.
                const row = await prisma.programParticipant.findUnique({
                    where: { programId_personId: { programId: shopifyProgram.id, personId: commonId } },
                });
                expect(row).toBeNull();
            } finally {
                logSpy.mockRestore();
                process.env.CHECKIN_ENV = prevCheckinEnv;
                await prisma.programParticipant.deleteMany({ where: { programId: shopifyProgram.id } });
                await prisma.program.delete({ where: { id: shopifyProgram.id } });
            }
        });

        // #1519: the lead mentor is authorized to remove the participant (same
        // seat-freeing outcome as staff above), but can't act on Shopify
        // inventory, so the advisory must not reach them.
        it('does NOT advise (no notice) on ACTIVE removal from a capped Shopify program when the lead mentor removes', async () => {
            const prevCheckinEnv = process.env.CHECKIN_ENV;
            process.env.CHECKIN_ENV = 'local';
            const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const shopifyProgram = await prisma.program.create({
                data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Notice Lead Partic API Test', enrollmentStatus: 'OPEN', maxParticipants: 5, shopifyVariantId: 'dev-mock-variant-notice-lead', leadMentorId: leadId },
            });
            try {
                await prisma.programParticipant.create({
                    data: { programId: shopifyProgram.id, personId: commonId, status: 'ACTIVE' },
                });
                (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } }); // lead-mentor removal

                const res = await DELETE(
                    new Request(`http://localhost:4000/api/programs/${shopifyProgram.id}/participants`, {
                        method: 'DELETE',
                        headers: { cookie: 'session=test' },
                        body: JSON.stringify({ participantId: commonId }),
                    }) as unknown as import("next/server").NextRequest,
                    createParams(shopifyProgram.id) as unknown as never,
                );
                expect(res.status).toBe(200);
                const data = await res.json();
                expect(data.notice).toBeUndefined();
                expect(data.warning).toBeUndefined();
                expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Would adjust inventory by 1'));
                // Seat-freeing itself is unaffected: the row is still gone.
                const row = await prisma.programParticipant.findUnique({
                    where: { programId_personId: { programId: shopifyProgram.id, personId: commonId } },
                });
                expect(row).toBeNull();
            } finally {
                logSpy.mockRestore();
                process.env.CHECKIN_ENV = prevCheckinEnv;
                await prisma.programParticipant.deleteMany({ where: { programId: shopifyProgram.id } });
                await prisma.program.delete({ where: { id: shopifyProgram.id } });
            }
        });

        // #1519: same for self-removal (e.g. a parent withdrawing themselves via
        // the public program page) — authorized to free the seat, but not to act
        // on Shopify inventory.
        it('does NOT advise (no notice) on ACTIVE removal from a capped Shopify program on self-removal', async () => {
            const prevCheckinEnv = process.env.CHECKIN_ENV;
            process.env.CHECKIN_ENV = 'local';
            const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const shopifyProgram = await prisma.program.create({
                data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Notice Self Partic API Test', enrollmentStatus: 'OPEN', maxParticipants: 5, shopifyVariantId: 'dev-mock-variant-notice-self' },
            });
            try {
                await prisma.programParticipant.create({
                    data: { programId: shopifyProgram.id, personId: commonId, status: 'ACTIVE' },
                });
                (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } }); // self-removal

                const res = await DELETE(
                    new Request(`http://localhost:4000/api/programs/${shopifyProgram.id}/participants`, {
                        method: 'DELETE',
                        headers: { cookie: 'session=test' },
                        body: JSON.stringify({ participantId: commonId }),
                    }) as unknown as import("next/server").NextRequest,
                    createParams(shopifyProgram.id) as unknown as never,
                );
                expect(res.status).toBe(200);
                const data = await res.json();
                expect(data.notice).toBeUndefined();
                expect(data.warning).toBeUndefined();
                expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Would adjust inventory by 1'));
                // Seat-freeing itself is unaffected: the row is still gone.
                const row = await prisma.programParticipant.findUnique({
                    where: { programId_personId: { programId: shopifyProgram.id, personId: commonId } },
                });
                expect(row).toBeNull();
            } finally {
                logSpy.mockRestore();
                process.env.CHECKIN_ENV = prevCheckinEnv;
                await prisma.programParticipant.deleteMany({ where: { programId: shopifyProgram.id } });
                await prisma.program.delete({ where: { id: shopifyProgram.id } });
            }
        });

        // A PENDING non-scholarship row never took a seat, so removing it frees
        // nothing and carries no notice.
        it('does NOT advise (no notice) when removing a PENDING participant with no hold', async () => {
            const shopifyProgram = await prisma.program.create({
                data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Notice Pending Partic API Test', enrollmentStatus: 'OPEN', maxParticipants: 5, shopifyVariantId: 'dev-mock-variant-notice-pending' },
            });
            try {
                await prisma.programParticipant.create({
                    data: { programId: shopifyProgram.id, personId: commonId, status: 'PENDING' },
                });
                (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } }); // self-removal

                const res = await DELETE(
                    new Request(`http://localhost:4000/api/programs/${shopifyProgram.id}/participants`, {
                        method: 'DELETE',
                        body: JSON.stringify({ participantId: commonId }),
                    }) as unknown as import("next/server").NextRequest,
                    createParams(shopifyProgram.id) as unknown as never,
                );
                expect(res.status).toBe(200);
                const data = await res.json();
                expect(data.notice).toBeUndefined();
            } finally {
                await prisma.programParticipant.deleteMany({ where: { programId: shopifyProgram.id } });
                await prisma.program.delete({ where: { id: shopifyProgram.id } });
            }
        });

        // Uncapped programs track no inventory (inventory_management=null), so an
        // ACTIVE removal there frees no tracked seat — no notice, no Shopify call.
        it('does NOT advise (no notice) on ACTIVE removal from an UNCAPPED program', async () => {
            const prevCheckinEnv = process.env.CHECKIN_ENV;
            process.env.CHECKIN_ENV = 'local';
            const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const uncappedProgram = await prisma.program.create({
                data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Notice Uncapped Partic API Test', enrollmentStatus: 'OPEN', maxParticipants: null, shopifyVariantId: 'dev-mock-variant-notice-uncapped' },
            });
            try {
                await prisma.programParticipant.create({
                    data: { programId: uncappedProgram.id, personId: commonId, status: 'ACTIVE' },
                });
                (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } }); // self-removal

                const res = await DELETE(
                    new Request(`http://localhost:4000/api/programs/${uncappedProgram.id}/participants`, {
                        method: 'DELETE',
                        headers: { cookie: 'session=test' },
                        body: JSON.stringify({ participantId: commonId }),
                    }) as unknown as import("next/server").NextRequest,
                    createParams(uncappedProgram.id) as unknown as never,
                );
                expect(res.status).toBe(200);
                const data = await res.json();
                expect(data.notice).toBeUndefined();
                expect(logSpy).not.toHaveBeenCalled();
            } finally {
                logSpy.mockRestore();
                process.env.CHECKIN_ENV = prevCheckinEnv;
                await prisma.programParticipant.deleteMany({ where: { programId: uncappedProgram.id } });
                await prisma.program.delete({ where: { id: uncappedProgram.id } });
            }
        });

        it.each([
            ['PENDING', 200],
            ['ACTIVE', 403],
        ] as const)('lets a household lead withdraw their own %s child only while unpaid (%i)', async (status, expected) => {
            await prisma.programParticipant.upsert({
                where: { programId_personId: { programId: freeProgramId, personId: youthDepId } },
                create: { programId: freeProgramId, personId: youthDepId, status },
                update: { status },
            });
            // No board flag on the session: the household-lead path alone decides it.
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId } });

            const res = await DELETE(
                new Request(`http://localhost:4000/api/programs/${freeProgramId}/participants`, {
                    method: 'DELETE',
                    body: JSON.stringify({ participantId: youthDepId }),
                }) as unknown as import("next/server").NextRequest,
                createParams(freeProgramId) as unknown as never,
            );
            expect(res.status).toBe(expected);
            const row = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId: freeProgramId, personId: youthDepId } },
            });
            if (expected === 403) {
                expect((await res.json()).error).toMatch(/ask the board/i);
                expect(row).not.toBeNull();
                await prisma.programParticipant.delete({ where: { programId_personId: { programId: freeProgramId, personId: youthDepId } } });
            } else {
                expect(row).toBeNull();
            }
        });

        // The lead path's paid check lives in the delete itself, so a row that
        // turned ACTIVE after any earlier read is still refused, never deleted.
        it('refuses the unpaid-only delete once the row is ACTIVE, keeping the row', async () => {
            await prisma.programParticipant.upsert({
                where: { programId_personId: { programId: freeProgramId, personId: youthDepId } },
                create: { programId: freeProgramId, personId: youthDepId, status: 'ACTIVE' },
                update: { status: 'ACTIVE' },
            });
            try {
                await expect(withdrawAndReleaseHold(freeProgramId, youthDepId, {}, 'PENDING'))
                    .rejects.toMatchObject({ code: 'P2025' });
                const row = await prisma.programParticipant.findUnique({
                    where: { programId_personId: { programId: freeProgramId, personId: youthDepId } },
                });
                expect(row?.status).toBe('ACTIVE');
            } finally {
                await prisma.programParticipant.deleteMany({ where: { programId: freeProgramId, personId: youthDepId } });
            }
        });

        it("refuses a household lead withdrawing another household's child", async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId } });

            const res = await DELETE(
                new Request(`http://localhost:4000/api/programs/${fullProgramId}/participants`, {
                    method: 'DELETE',
                    body: JSON.stringify({ participantId: otherId }),
                }) as unknown as import("next/server").NextRequest,
                createParams(fullProgramId) as unknown as never,
            );
            expect(res.status).toBe(403);
            const row = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId: fullProgramId, personId: otherId } },
            });
            expect(row).not.toBeNull();
        });

        // Lead mentors must never learn scholarship / payment-plan status, so
        // withdrawing a scholarship-held seat must look like any other removal.
        it('gives a lead mentor no scholarship information when withdrawing a held seat', async () => {
            const prevCheckinEnv = process.env.CHECKIN_ENV;
            process.env.CHECKIN_ENV = 'local';
            const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const shopifyProgram = await prisma.program.create({
                data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Held Lead Partic API Test', enrollmentStatus: 'OPEN', shopifyVariantId: 'dev-mock-variant-held-lead', leadMentorId: leadId },
            });
            try {
                await prisma.programParticipant.create({
                    data: { programId: shopifyProgram.id, personId: commonId, status: 'PENDING', inventoryHeldAt: new Date(), paymentPlanDeniedAt: new Date() },
                });
                (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });

                const res = await DELETE(
                    new Request(`http://localhost:4000/api/programs/${shopifyProgram.id}/participants`, {
                        method: 'DELETE',
                        headers: { cookie: 'session=test' },
                        body: JSON.stringify({ participantId: commonId }),
                    }) as unknown as import("next/server").NextRequest,
                    createParams(shopifyProgram.id) as unknown as never,
                );
                expect(res.status).toBe(200);
                expect(await res.json()).toEqual({ success: true });
                // The hold is still released server-side.
                expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Would adjust inventory by 1 for variant: dev-mock-variant-held-lead'));
            } finally {
                logSpy.mockRestore();
                process.env.CHECKIN_ENV = prevCheckinEnv;
                await prisma.programParticipant.deleteMany({ where: { programId: shopifyProgram.id } });
                await prisma.program.delete({ where: { id: shopifyProgram.id } });
            }
        });
    });
});
