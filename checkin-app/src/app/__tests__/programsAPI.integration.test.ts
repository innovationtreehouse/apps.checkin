/**
 * @jest-environment node
 */
/**
 * Integration Tests for Programs API
 * Tests GET and POST /api/programs for fetching programs and creating new ones.
 */

import { GET, POST } from '@/app/api/programs/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { classifications } from '@/security/generated/classifications';
import { ORG_DOMAIN } from '@/lib/config';
// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));
// Mock Notifications
jest.mock('@/lib/notifications', () => ({
    sendNotification: jest.fn()
}));

describe('Programs API Integration Tests', () => {
    let adminId: number;
    let commonId: number;
    let leadId: number;

    beforeAll(async () => {
        // Clean up any leaked state
        const existingUsers = await prisma.person.findMany({
            where: { email: { contains: 'programs-api-test' } },
            select: { id: true }
        });
        const existingUserIds = existingUsers.map(u => u.id);
        
        await prisma.program.deleteMany({
            where: { name: { contains: 'API Test Program' } }
        });
        
        await prisma.auditLog.deleteMany({
            where: { actorId: { in: existingUserIds } }
        });
        
        await prisma.person.deleteMany({
            where: { id: { in: existingUserIds } }
        });

        // Create Admin
        const admin = await prisma.person.create({
            data: { email: 'admin-programs-api-test@example.com', name: 'Admin', isSysadmin: true, household: { create: { name: "Test HH" } } }
        });
        adminId = admin.id;

        // Create Lead
        const lead = await prisma.person.create({
            data: { email: 'lead-programs-api-test@example.com', name: 'Lead', isDeclaredAdult: true, household: { create: { name: "Test HH" } } }
        });
        leadId = lead.id;

        // Create Common User
        const commonUser = await prisma.person.create({
            data: { email: 'common-programs-api-test@example.com', name: 'Common', household: { create: { name: "Test HH" } } }
        });
        commonId = commonUser.id;

        // Create mock programs
        await prisma.program.createMany({
            data: [
                { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Public API Test Program', phase: 'RUNNING', orgMemberOnly: false, minAge: 10, maxAge: 18, leadMentorNotificationSettings: { notifyRsvp: true } },
                { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Draft API Test Program', phase: 'PLANNING', orgMemberOnly: false, leadMentorId: leadId },
                { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Member Only API Test Program', phase: 'RUNNING', orgMemberOnly: true },
                { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Public Member Only API Test Program', phase: 'RUNNING', orgMemberOnly: true, publiclyVisible: true }
            ]
        });
    });

    afterAll(async () => {
        const existingUserIds = [adminId, leadId, commonId];

        await prisma.program.deleteMany({
            where: { name: { contains: 'API Test Program' } }
        });
        
        await prisma.auditLog.deleteMany({
            where: { actorId: { in: existingUserIds } }
        });
        
        await prisma.person.deleteMany({
            where: { id: { in: existingUserIds } }
        });
    });

    describe('GET /api/programs', () => {
        it('should return only public, active programs for unauthenticated users', async () => {
             (getServerSession as jest.Mock).mockResolvedValue(null);

             const req = new Request('http://localhost:4000/api/programs', { method: 'GET' });
             const res = await GET(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(200);

             const programs = await res.json();
             
             const publicActive = programs.find((p: { id?: number; email?: string; name?: string; participantId?: number; level?: string; status?: string; role?: string; type?: string; [key: string]: unknown }) => p.name === 'Public API Test Program');
             const draft = programs.find((p: { id?: number; email?: string; name?: string; participantId?: number; level?: string; status?: string; role?: string; type?: string; [key: string]: unknown }) => p.name === 'Draft API Test Program');
             const orgMemberOnly = programs.find((p: { id?: number; email?: string; name?: string; participantId?: number; level?: string; status?: string; role?: string; type?: string; [key: string]: unknown }) => p.name === 'Member Only API Test Program');

             expect(publicActive).toBeDefined();
             expect(draft).toBeUndefined(); // Filtered because it is in PLANNING
             expect(orgMemberOnly).toBeUndefined(); // Filtered because orgMemberOnly is true
        });

        it('shows a publiclyVisible members-only program to an unauthenticated caller', async () => {
             (getServerSession as jest.Mock).mockResolvedValue(null);

             const req = new Request('http://localhost:4000/api/programs', { method: 'GET' });
             const res = await GET(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(200);

             const programs = await res.json();
             const hidden = programs.find((p: { name?: string }) => p.name === 'Member Only API Test Program');
             const shown = programs.find((p: { name?: string }) => p.name === 'Public Member Only API Test Program');

             expect(hidden).toBeUndefined(); // members-only and NOT publiclyVisible — stays hidden
             expect(shown).toBeDefined();    // members-only but opted into the public catalogue
        });

        it('should return drafts if the authenticated user is the lead mentor', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });

             const req = new Request('http://localhost:4000/api/programs', { method: 'GET' });
             const res = await GET(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(200);

             const programs = await res.json();
             const draft = programs.find((p: { id?: number; email?: string; name?: string; participantId?: number; level?: string; status?: string; role?: string; type?: string; [key: string]: unknown }) => p.name === 'Draft API Test Program');

             expect(draft).toBeDefined(); // Revealed because the user is the lead
        });

        it('should return all programs including drafts and member-only for admins', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

             const req = new Request('http://localhost:4000/api/programs', { method: 'GET' });
             const res = await GET(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(200);

             const programs = await res.json();
             const draft = programs.find((p: { id?: number; email?: string; name?: string; participantId?: number; level?: string; status?: string; role?: string; type?: string; [key: string]: unknown }) => p.name === 'Draft API Test Program');
             const orgMemberOnly = programs.find((p: { id?: number; email?: string; name?: string; participantId?: number; level?: string; status?: string; role?: string; type?: string; [key: string]: unknown }) => p.name === 'Member Only API Test Program');

             expect(draft).toBeDefined(); // Revealed because admin
             expect(orgMemberOnly).toBeDefined(); // Revealed because admin
        });

        // #1397: dues paid, background check still with the board — the catalog
        // shows them members-only programs, same as an ACTIVE household.
        it('reveals member-only programs to a household that has paid but is awaiting background clearance', async () => {
             const paidPending = await prisma.person.create({
                 data: {
                     email: 'paid-pending-programs-api-test@example.com',
                     name: 'Paid Pending',
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

                 const req = new Request('http://localhost:4000/api/programs', { method: 'GET' });
                 const res = await GET(req as unknown as import("next/server").NextRequest);
                 expect(res.status).toBe(200);

                 const programs = await res.json();
                 const orgMemberOnly = programs.find((p: { name?: string }) => p.name === 'Member Only API Test Program');
                 expect(orgMemberOnly).toBeDefined();
             } finally {
                 await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: paidPending.householdId } } });
                 await prisma.orgMembership.deleteMany({ where: { householdId: paidPending.householdId } });
                 await prisma.person.delete({ where: { id: paidPending.id } });
             }
        });

        // The catalog is deliberately anonymous-readable, so the projection — not a
        // route gate — is what keeps `personal`-tier data off the wire. Both the
        // cached anonymous path and the live session path must ship public columns only.
        //
        // Expected keys are DERIVED from the generated classifications rather than
        // listed here: the route's PUBLIC_PROGRAM_SELECT is a hand-maintained copy of
        // policy data, so a hardcoded list would rot in lockstep with it. Adding a
        // non-public column to Program now fails this test instead of leaking.
        it.each([
            ['anonymous', null],
            ['admin session', { user: { id: undefined as number | undefined, isSysadmin: true } }],
        ])('exposes only public-tier Program columns (%s)', async (_label, session) => {
             if (session) session.user.id = adminId;
             (getServerSession as jest.Mock).mockResolvedValue(session);

             const req = new Request('http://localhost:4000/api/programs', { method: 'GET' });
             const res = await GET(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(200);

             const programs = await res.json();
             const publicActive = programs.find((p: { name?: string }) => p.name === 'Public API Test Program');

             const publicColumns = Object.entries(classifications.Program)
                 .filter(([, tier]) => tier === 'public')
                 .map(([field]) => field);

             expect(publicActive).toBeDefined();
             expect(publicColumns).not.toHaveLength(0); // guard: a broken import would vacuously pass
             expect(Object.keys(publicActive).sort()).toEqual([...publicColumns, '_count'].sort());
             expect(publicActive._count).toEqual({ participants: 0, volunteers: 0, events: 0 });
        });
    });

    // ── ops-stg ACCESS GATE regression (Finding 1, 2026-07-20) ──────────────────
    // This route is a bare `export async function GET` — no withAuth, no
    // handler()/registry entry — that calls getOptionalSessionUser directly and
    // treats "no session" as the public-catalog happy path (correct in prod/dev).
    // getOptionalSessionUser collapses a staging-gate-rejected caller to the SAME
    // `undefined` shape as a genuinely anonymous visitor, so without an explicit
    // check an anonymous curl would read the full prod-copied catalog (names,
    // dates, prices, Shopify ids, live enrollment counts) straight through.
    describe('GET /api/programs — ops-stg access gate', () => {
        const CHECKIN_ENV_BEFORE = process.env.CHECKIN_ENV;

        beforeEach(() => {
            process.env.CHECKIN_ENV = 'stg';
        });

        afterAll(() => {
            if (CHECKIN_ENV_BEFORE === undefined) delete process.env.CHECKIN_ENV;
            else process.env.CHECKIN_ENV = CHECKIN_ENV_BEFORE;
        });

        it('DENIES an anonymous caller — the regression case for Finding 1', async () => {
            (getServerSession as jest.Mock).mockResolvedValue(null);

            const req = new Request('http://localhost:4000/api/programs', { method: 'GET' });
            const res = await GET(req as unknown as import("next/server").NextRequest);

            expect(res.status).toBe(401);
            const text = await res.text();
            expect(text).not.toContain('Public API Test Program');
        });

        it('ALLOWS an authenticated admin who is ALSO a verified org member', async () => {
            // isSysadmin alone does NOT bypass the staging gate — only a verified
            // innovationtreehouse.org member or canAccessStaging does (see
            // isStagingAccessAllowed). Both claims must be on the mocked session.
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: adminId, isSysadmin: true, hd: ORG_DOMAIN, emailVerified: true },
            });

            const req = new Request('http://localhost:4000/api/programs', { method: 'GET' });
            const res = await GET(req as unknown as import("next/server").NextRequest);

            expect(res.status).toBe(200);
        });

        it('DENIES an authenticated admin who is NOT a verified org member and has no canAccessStaging flag', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

            const req = new Request('http://localhost:4000/api/programs', { method: 'GET' });
            const res = await GET(req as unknown as import("next/server").NextRequest);

            expect(res.status).toBe(401);
        });

        it('is inert outside staging: the same anonymous request succeeds once CHECKIN_ENV is not stg', async () => {
            process.env.CHECKIN_ENV = 'prod';
            (getServerSession as jest.Mock).mockResolvedValue(null);

            const req = new Request('http://localhost:4000/api/programs', { method: 'GET' });
            const res = await GET(req as unknown as import("next/server").NextRequest);

            expect(res.status).toBe(200);
        });
    });

    describe('POST /api/programs', () => {
        it('should block non-admins from creating a program', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } });

             const req = new Request('http://localhost:4000/api/programs', {
                 method: 'POST',
                 body: JSON.stringify({ name: 'New API Test Program' })
             });
             const res = await POST(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(403);
             const data = await res.json();
             expect(data.error).toMatch(/Forbidden/);
        });

        it('should missing required program name', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

             const req = new Request('http://localhost:4000/api/programs', {
                 method: 'POST',
                 body: JSON.stringify({ leadMentorId: leadId, startAt: '2026-01-01', endAt: '2026-12-31' })
             });
             const res = await POST(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(400);
        });

        it('should require max participants', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

             const req = new Request('http://localhost:4000/api/programs', {
                 method: 'POST',
                 body: JSON.stringify({ name: 'New API Test Program', leadMentorId: leadId, startAt: '2026-01-01', endAt: '2026-12-31' })
             });
             const res = await POST(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(400);
             const data = await res.json();
             expect(data.error).toMatch(/Max participants/);
        });

        it('should allow admins to create a program', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

             const req = new Request('http://localhost:4000/api/programs', {
                 method: 'POST',
                 body: JSON.stringify({ name: 'Created API Test Program', leadMentorId: leadId, startAt: '2026-01-01', endAt: '2026-12-31', minAge: 12, maxAge: 17, maxParticipants: 50 })
             });
             const res = await POST(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(200);

             const data = await res.json();
             expect(data.success).toBe(true);
             expect(data.program.name).toBe('Created API Test Program');
             expect(data.program.leadMentorId).toBe(leadId);
             expect(data.program.minAge).toBe(12);
             expect(data.program.maxAge).toBe(17);
             expect(data.program.maxParticipants).toBe(50);
        });

        it('clamps publiclyVisible to false on create when the program is not members-only', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

             const req = new Request('http://localhost:4000/api/programs', {
                 method: 'POST',
                 body: JSON.stringify({ name: 'Clamp Create API Test Program', leadMentorId: leadId, startAt: '2026-01-01', endAt: '2026-12-31', maxParticipants: 50, orgMemberOnly: false, publiclyVisible: true })
             });
             const res = await POST(req as unknown as import("next/server").NextRequest);
             expect(res.status).toBe(200);

             const data = await res.json();
             expect(data.program.orgMemberOnly).toBe(false);
             expect(data.program.publiclyVisible).toBe(false);
        });
    });
});
