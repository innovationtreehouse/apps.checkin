import { POST as ParticipantPost } from '@/app/api/programs/[id]/participants/route';
import { POST as ShopifyWebhook } from '@/app/api/webhooks/shopify/route';
import { GET as CronPending } from '@/app/api/cron/pending-participants/route';
import prisma from '@/lib/prisma';
import crypto from 'crypto';

// Generic mock implementation
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

jest.mock('@/lib/notifications', () => ({
    sendNotification: jest.fn()
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockGetSession = require('next-auth/next').getServerSession;

describe('Program Lifecycle Integration Tests', () => {
    let testProgramId: number;
    let testParticipantId: number;
    let leadMentorId: number;
    let boardAdminId: number;

    beforeAll(async () => {
        // Setup initial db state for test scope
        
        // 1. Create a board member
        const adminUser = await prisma.person.create({
            data: {
                name: "Board Tester",
                email: "board@test.com",
                googleId: "test-auth-board",
                isSysadmin: false,
                isBoardMember: true,
                dateOfBirth: new Date('1990-01-01'),
                household: { create: { name: "Test HH" } }
            }
        });
        boardAdminId = adminUser.id;

        // 2. Create a Lead Mentor
        const mentorUser = await prisma.person.create({
            data: {
                name: "Mentor Tester",
                email: "mentor@test.com",
                googleId: "test-auth-mentor",
                dateOfBirth: new Date('1985-01-01'),
                household: { create: { name: "Test HH" } }
            }
        });
        leadMentorId = mentorUser.id;

        // 3. Create a standard participant
        const standardUser = await prisma.person.create({
            data: {
                name: "Standard Tester",
                email: "participant@test.com",
                googleId: "test-auth-std",
                dateOfBirth: new Date('2000-01-01'),
                household: { create: { name: "Test HH" } }
            }
        });
        testParticipantId = standardUser.id;

        // 4. Create a program
        const program = await prisma.program.create({
            data: {
                startAt: new Date('2026-01-01'),
                endAt: new Date('2026-12-31'),
                name: "Integration Test Program",
                leadMentorId,
                orgMemberPriceCents: 50,
                nonOrgMemberPriceCents: 100,
                shopifyProductId: "test-prod",
                shopifyVariantId: "test-non-var",
                enrollmentStatus: "OPEN"
            }
        });
        testProgramId = program.id;
    });

    afterAll(async () => {
        // Teardown
        if (testProgramId) {
            await prisma.programParticipant.deleteMany({ where: { programId: testProgramId } });
            await prisma.program.delete({ where: { id: testProgramId } });
        }

        const idsToDelete = [testParticipantId, leadMentorId, boardAdminId].filter(id => id);
        if (idsToDelete.length > 0) {
            await prisma.person.deleteMany({ where: { id: { in: idsToDelete } } });
        }
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('Should allow Self-Enrollment and set status to PENDING', async () => {
        // Mock standard user logged in
        mockGetSession.mockResolvedValue({ user: { id: testParticipantId } });

        const req = new Request(`http://localhost/api/programs/${testProgramId}/participants`, {
            method: 'POST',
            body: JSON.stringify({ participantId: testParticipantId })
        });

        const res = await ParticipantPost(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(testProgramId) }) });
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.success).toBe(true);

        const dbRecord = await prisma.programParticipant.findUnique({
            where: { programId_personId: { programId: testProgramId, personId: testParticipantId } }
        });

        expect(dbRecord).toBeDefined();
        expect(dbRecord?.status).toBe('PENDING');
        expect(dbRecord?.pendingSince).toBeInstanceOf(Date);
        expect(dbRecord?.isPaymentPlanRequested).toBe(false);
    });

    it('Should block Lead Mentors from manually adding participants', async () => {
         mockGetSession.mockResolvedValue({ user: { id: leadMentorId } });

        const req = new Request(`http://localhost/api/programs/${testProgramId}/participants`, {
            method: 'POST',
            body: JSON.stringify({ participantId: testParticipantId }) // Adding someone else
        });

        const res = await ParticipantPost(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(testProgramId) }) });
        expect(res.status).toBe(403);
    });

    it('Should require a Board Member to supply override=true when bypassing payment flows', async () => {
        mockGetSession.mockResolvedValue({ user: { id: boardAdminId, isBoardMember: true } });

        const req = new Request(`http://localhost/api/programs/${testProgramId}/participants`, {
            method: 'POST',
            body: JSON.stringify({ participantId: testParticipantId }) // No override flag
        });

        const res = await ParticipantPost(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(testProgramId) }) });
        expect(res.status).toBe(400);
        
        const data = await res.json();
        expect(data.requiresOverride).toBe(true);
    });

    it('Should allow a Board Member to override and add a participant, defaulting to ACTIVE', async () => {
        mockGetSession.mockResolvedValue({ user: { id: boardAdminId, isBoardMember: true } });

        // Clean previous runs
        await prisma.programParticipant.deleteMany({ where: { programId: testProgramId, personId: testParticipantId } });

        const req = new Request(`http://localhost/api/programs/${testProgramId}/participants`, {
            method: 'POST',
            body: JSON.stringify({ participantId: testParticipantId, override: true })
        });

        const res = await ParticipantPost(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(testProgramId) }) });
        expect(res.status).toBe(200);

        const dbRecord = await prisma.programParticipant.findUnique({
            where: { programId_personId: { programId: testProgramId, personId: testParticipantId } }
        });

        // Overrides by board default to ACTIVE
        expect(dbRecord?.status).toBe('ACTIVE'); 
    });

    it('Shopify Webhook should mark a PENDING participant as ACTIVE', async () => {
        // 1. Reset user to PENDING state manually to simulate self-enroll flow
        // First, recreate or ensure it exists from the previous test
        await prisma.programParticipant.upsert({
            where: { programId_personId: { programId: testProgramId, personId: testParticipantId } },
            update: { status: 'PENDING', pendingSince: new Date() },
            create: { programId: testProgramId, personId: testParticipantId, status: 'PENDING', pendingSince: new Date() }
        });

        // 2. Build Shopify webhook payload. line_items must contain the program's
        // own Shopify variant (shopifyVariantId set in beforeAll) — the route
        // verifies this before activating (see route.ts).
        const payload = JSON.stringify({
            id: 12345,
            financial_status: 'paid',
            line_items: [{ variant_id: "test-non-var" }],
            note_attributes: [
                { name: "CheckMeIn_Account_ID", value: String(testParticipantId) },
                { name: "Program_ID", value: String(testProgramId) }
            ]
        });

        process.env.SHOPIFY_WEBHOOK_SECRET = 'test_secret';
        
        const hmac = crypto.createHmac('sha256', 'test_secret').update(payload, 'utf8').digest('base64');

        const req = new Request(`http://localhost/api/webhooks/shopify`, {
            method: 'POST',
            headers: {
                'x-shopify-hmac-sha256': hmac,
                'x-shopify-topic': 'orders/paid',
                'Content-Type': 'application/json'
            },
            body: payload
        });

        const res = await ShopifyWebhook(req);
        expect(res.status).toBe(200);

        const dbRecord = await prisma.programParticipant.findUnique({
            where: { programId_personId: { programId: testProgramId, personId: testParticipantId } }
        });

        expect(dbRecord?.status).toBe('ACTIVE');
        expect(dbRecord?.pendingSince).toBeNull();
    });

     it('Cron flags overdue PENDING participants after 7 days without removing them; requested rows are excluded', async () => {
        process.env.CRON_SECRET = 'cron_test_secret';

        // 1. Set user to 8 days old PENDING
        const eightDaysAgo = new Date();
        eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);

        await prisma.programParticipant.upsert({
             where: { programId_personId: { programId: testProgramId, personId: testParticipantId } },
             update: { status: 'PENDING', pendingSince: eightDaysAgo, isPaymentPlanRequested: false },
             create: { programId: testProgramId, personId: testParticipantId, status: 'PENDING', pendingSince: eightDaysAgo, isPaymentPlanRequested: false }
        });

        let req = new Request(`http://localhost/api/cron/pending-participants`, {
            headers: { 'authorization': `Bearer cron_test_secret` }
        });

        let res = await CronPending(req);
        let data = await res.json();
        
        expect(res.status).toBe(200);
        // The cron NEVER removes (reviewer decision, PR #1094): the row is flagged
        // overdue and left for the board. >= because the sweep is global and other
        // suites' rows may share the DB in a full CI run.
        expect(data.kicked).toBeUndefined();
        expect(data.overdue).toBeGreaterThanOrEqual(1);

        // Verify the row SURVIVES the sweep.
        let dbRecord = await prisma.programParticipant.findUnique({
            where: { programId_personId: { programId: testProgramId, personId: testParticipantId } }
        });
        expect(dbRecord?.status).toBe('PENDING');

        // 2. Flip the surviving row to isPaymentPlanRequested = true — the sweep
        // excludes requested rows entirely (scholarship applicants are the grace
        // flow's business, not the non-payment sweep's).
        await prisma.programParticipant.update({
            where: { programId_personId: { programId: testProgramId, personId: testParticipantId } },
            data: { isPaymentPlanRequested: true }
        });

         req = new Request(`http://localhost/api/cron/pending-participants`, {
            headers: { 'authorization': `Bearer cron_test_secret` }
        });

        res = await CronPending(req);
        data = await res.json();
        expect(res.status).toBe(200);

         // Verify Still there
        dbRecord = await prisma.programParticipant.findUnique({
            where: { programId_personId: { programId: testProgramId, personId: testParticipantId } }
        });
        expect(dbRecord).toBeDefined();
    });
});
