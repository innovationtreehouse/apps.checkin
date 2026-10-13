import { POST as CreateProgram } from '@/app/api/programs/route';
import { POST as AddEvent } from '@/app/api/events/route';
import { PATCH as PatchProgram } from '@/app/api/programs/[id]/route';
import { PATCH as AddHouseholdMember } from '@/app/api/household/route';
import { POST as EnrollParticipant } from '@/app/api/programs/[id]/participants/route';
import { POST as ShopifyWebhook } from '@/app/api/webhooks/shopify/route';
import prisma from '@/lib/prisma';
import crypto from 'crypto';

// Mocking dependencies
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

jest.mock('@/lib/notifications', () => ({
    sendNotification: jest.fn(),
}));

jest.mock('@/lib/shopify', () => ({
    createShopifySingleVariantProgram: jest.fn().mockResolvedValue({
        shopifyProductId: 'mock-product-id',
        shopifyVariantId: 'mock-variant-id',
    }),
}));

// Mock Prisma
jest.mock('@/lib/prisma', () => {
  const mock = {
    person: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
    emergencyContact: {
      findMany: jest.fn(),
    },
    program: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    event: {
      create: jest.fn(),
      createMany: jest.fn(),
      count: jest.fn(),
      deleteMany: jest.fn(),
    },
    household: {
      create: jest.fn(),
      delete: jest.fn(),
    },
    membership: {
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    programParticipant: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
    appSettings: {
      // Event creation reads the org timezone via getAppSettings().
      upsert: jest.fn().mockResolvedValue({ id: 1, timezone: 'America/Chicago', locale: 'en-US' }),
    },
    // Enroll route now wraps the insert in $transaction + a FOR UPDATE
    // capacity check; run the callback against this same mock as the tx client.
    // The household PATCH route also mints the new member's id through
    // mintPersonId(tx), which is one $queryRaw — hence the resolved row.
    $queryRaw: jest.fn().mockResolvedValue([{ value: 100000 }]),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mock as any).$transaction = jest.fn((cb: (tx: typeof mock) => unknown) => cb(mock));
  return { __esModule: true, default: mock };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockGetSession = require('next-auth/next').getServerSession;

describe('Full Program Signup Integration Flow', () => {
    const sysAdminId = 1;
    const leadUserId = 2;
    const childParticipantId = 3;
    const programId = 10;
    const householdId = 100;

    const SHOPIFY_SECRET = 'test_shopify_secret';

    beforeAll(() => {
        process.env.SHOPIFY_WEBHOOK_SECRET = SHOPIFY_SECRET;
    });

    it('should complete the full program signup flow', async () => {
        // 1. SysAdmin creates a program
        mockGetSession.mockResolvedValue({ user: { id: sysAdminId, isSysadmin: true } });
        (prisma.person.findUnique as jest.Mock).mockResolvedValue({ dateOfBirth: null, isDeclaredAdult: true });
        (prisma.program.create as jest.Mock).mockResolvedValue({ id: programId, name: 'Integration Test Program' });
        (prisma.auditLog.create as jest.Mock).mockResolvedValue({});

        const createProgramReq = new Request('http://localhost/api/programs', {
            method: 'POST',
            body: JSON.stringify({
                name: 'Integration Test Program',
                startAt: '2026-01-01',
                endAt: '2026-12-31',
                memberPrice: 50,
                nonMemberPrice: 100,
                leadMentorId: sysAdminId,
                maxParticipants: 50,
            }),
        });
        const createProgramRes = await CreateProgram(createProgramReq as unknown as import("next/server").NextRequest);
        expect(createProgramRes.status).toBe(200);
        const createProgramData = await createProgramRes.json();
        expect(createProgramData.program.id).toBe(programId);

        // 2. SysAdmin adds an event (required for publishing)
        (prisma.program.findUnique as jest.Mock).mockResolvedValue({ id: programId, leadMentorId: sysAdminId });
        (prisma.event.createMany as jest.Mock).mockResolvedValue({ count: 1 });

        const addEventReq = new Request('http://localhost/api/events', {
            method: 'POST',
            body: JSON.stringify({
                name: 'First Class',
                programId: String(programId),
                startDate: '2099-01-01',
                startTime: '15:00',
                endTime: '16:00',
            }),
        });
        const addEventRes = await AddEvent(addEventReq as unknown as import("next/server").NextRequest);
        expect(addEventRes.status).toBe(200);

        // 3. SysAdmin publishes the program via the base PATCH
        (prisma.program.findUnique as jest.Mock).mockResolvedValue({
            id: programId,
            leadMentorId: sysAdminId,
            phase: 'PLANNING',
        });
        (prisma.event.count as jest.Mock).mockResolvedValue(1);
        (prisma.program.update as jest.Mock).mockResolvedValue({ id: programId, phase: 'UPCOMING', enrollmentStatus: 'OPEN' });

        const publishReq = new Request(`http://localhost/api/programs/${programId}`, {
            method: 'PATCH',
            body: JSON.stringify({ phase: 'UPCOMING', enrollmentStatus: 'OPEN' }),
        });
        const publishRes = await PatchProgram(publishReq as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(programId) }) });
        expect(publishRes.status).toBe(200);

        // 4. Lead user (who already has a household from signup) adds a child member
        mockGetSession.mockResolvedValue({ user: { id: leadUserId } });
        (prisma.person.findUnique as jest.Mock).mockResolvedValueOnce({ id: leadUserId, householdId, isHouseholdLead: true });
        (prisma.person.create as jest.Mock).mockResolvedValue({ id: childParticipantId, householdId });
        // Adding a member reconciles emergency contacts (direction B); no contacts/members to flag here.
        (prisma.person.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.emergencyContact.findMany as jest.Mock).mockResolvedValue([]);

        const addChildReq = new Request('http://localhost/api/household', {
            method: 'PATCH',
            body: JSON.stringify({
                memberName: 'Child Participant',
                memberDob: '2015-01-01',
            }),
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const addChildRes = await AddHouseholdMember(addChildReq as any, { type: 'session', user: { id: leadUserId } } as any);
        expect(addChildRes.status).toBe(200);
        const addChildData = await addChildRes.json();
        expect(addChildData.member.id).toBe(childParticipantId);

        // 6. Lead user enrolls child in the program
        (prisma.program.findUnique as jest.Mock).mockResolvedValue({
            id: programId,
            name: 'Integration Test Program',
            enrollmentStatus: 'OPEN',
            maxParticipants: null,
            _count: { participants: 0 }
        });
        (prisma.person.findUnique as jest.Mock).mockResolvedValue({ id: childParticipantId, householdId, dateOfBirth: new Date('2015-01-01') });
        (prisma.person.findFirst as jest.Mock).mockResolvedValue({ id: leadUserId });
        (prisma.programParticipant.create as jest.Mock).mockResolvedValue({ programId, personId: childParticipantId, status: 'PENDING' });

        const enrollReq = new Request(`http://localhost/api/programs/${programId}/participants`, {
            method: 'POST',
            body: JSON.stringify({ participantId: childParticipantId }),
        });
        const enrollRes = await EnrollParticipant(enrollReq as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(programId) }) });
        expect(enrollRes.status).toBe(200);

        // 7. Verify PENDING status
        (prisma.programParticipant.findUnique as jest.Mock).mockResolvedValue({ programId, personId: childParticipantId, status: 'PENDING' });
        const participantRecord = await prisma.programParticipant.findUnique({
            where: { programId_personId: { programId, personId: childParticipantId } },
        });
        expect(participantRecord?.status).toBe('PENDING');

        // 8. Shopify Webhook call
        (prisma.programParticipant.findUnique as jest.Mock).mockResolvedValue({ programId, personId: childParticipantId, status: 'PENDING' });
        (prisma.program.findUnique as jest.Mock).mockResolvedValue({ id: programId, shopifyVariantId: 'mock-variant-id' });
        (prisma.programParticipant.count as jest.Mock).mockResolvedValue(1);
        (prisma.programParticipant.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

        const webhookPayload = JSON.stringify({
            financial_status: 'paid',
            line_items: [{ variant_id: 'mock-variant-id', quantity: 1 }],
            note_attributes: [
                { name: 'CheckMeIn_Account_ID', value: String(childParticipantId) },
                { name: 'Program_ID', value: String(programId) },
            ],
        });
        const hmac = crypto.createHmac('sha256', SHOPIFY_SECRET).update(webhookPayload).digest('base64');
        const webhookReq = new Request('http://localhost/api/webhooks/shopify', {
            method: 'POST',
            headers: {
                'x-shopify-hmac-sha256': hmac,
                'x-shopify-topic': 'orders/paid',
            },
            body: webhookPayload,
        });
        const webhookRes = await ShopifyWebhook(webhookReq);
        expect(webhookRes.status).toBe(200);

        // 9. Final Verification - the paid order flipped the enrollment ACTIVE
        expect(prisma.programParticipant.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ programId, personId: childParticipantId }),
            data: expect.objectContaining({ status: 'ACTIVE' }),
        }));
    });

    it('should fail to enroll if not a household lead and not self', async () => {
        const otherUserId = 999;
        mockGetSession.mockResolvedValue({ user: { id: otherUserId } });

        (prisma.program.findUnique as jest.Mock).mockResolvedValue({
            id: programId,
            enrollmentStatus: 'OPEN',
            maxParticipants: null,
            _count: { participants: 0 }
        });
        (prisma.person.findUnique as jest.Mock).mockResolvedValue({ id: childParticipantId, householdId, dateOfBirth: new Date('2015-01-01') });
        (prisma.person.findFirst as jest.Mock).mockResolvedValue(null); // Not a lead

        const enrollReq = new Request(`http://localhost/api/programs/${programId}/participants`, {
            method: 'POST',
            body: JSON.stringify({ participantId: childParticipantId }),
        });
        const enrollRes = await EnrollParticipant(enrollReq as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: String(programId) }) });
        expect(enrollRes.status).toBe(403);
    });
});
