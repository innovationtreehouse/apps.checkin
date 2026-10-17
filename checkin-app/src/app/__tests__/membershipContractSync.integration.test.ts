/**
 * @jest-environment node
 */
/**
 * Integration tests for syncContractStatus — the PRIMARY contract-completion path
 * in dev (the Zoho webhook is unreliable against a scale-to-zero instance). Pulls
 * the signing status from Zoho on the signing-return (?signed=1), records the
 * contract signed, and advances the process to PENDING_PAYMENT when BG consent
 * is already present. Best-effort: a Zoho hiccup is swallowed.
 *
 * Zoho is mocked (getAccessToken / getRequestStatus) like the other external tests.
 */

import { syncContractStatus } from '@/lib/membership/external';
import { normalizeAuditData } from '@/lib/auditPayload';
import { POST as SYNC_ROUTE } from '@/app/api/membership/contract/sync/route';
import { getRequestStatus } from '@/lib/membership/contract/zohoClient';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
// Advancing to PENDING_PAYMENT pings reviewers; don't hit Resend in tests.
jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));
// Mock the whole Zoho client so no real OAuth/HTTP happens. Only getAccessToken +
// getRequestStatus are exercised by syncContractStatus; the rest are stubs.
jest.mock('@/lib/membership/contract/zohoClient', () => ({
    getAccessToken: jest.fn().mockResolvedValue('test-token'),
    getRequestStatus: jest.fn(),
    createRequest: jest.fn(),
    submitRequest: jest.fn(),
    getEmbeddedSignUrl: jest.fn(),
}));

const mockGetRequestStatus = getRequestStatus as jest.Mock;

const TAG = 'contract-sync-test';

/**
 * A fresh applicant: household + membership + a process in the EXTERNAL phase, and
 * a participant (the lead) wired to that household so syncContractStatus(userId)
 * resolves the process via user.household.orgMembership.processes.
 */
async function makeApplicant(data: Record<string, unknown> = {}): Promise<{ userId: number; processId: number }> {
    const hh = await prisma.household.create({ data: { name: `Applicant ${TAG}` } });
    const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
    const proc = await prisma.orgMembershipProcess.create({
        data: {
            orgMembershipId: m.id,
            kind: 'INITIAL',
            status: 'PENDING_EXTERNAL_ACTION',
            zohoEnvelopeId: `zoho-${TAG}`,
            ...data,
        },
    });
    const user = await prisma.person.create({
        data: { email: `lead-${proc.id}-${TAG}@example.com`, name: 'Lead', householdId: hh.id },
    });
    return { userId: user.id, processId: proc.id };
}

/** Audit rows for a process, split by the field they record. */
async function audits(processId: number) {
    const rows = await prisma.auditLog.findMany({
        where: { tableName: 'OrgMembershipProcess', affectedEntityId: processId },
        select: { actorId: true, newData: true },
    });
    return {
        signed: rows.filter((r) => JSON.stringify(normalizeAuditData(r.newData)).includes('"contractSignedAt":true')),
        advanced: rows.filter((r) => JSON.stringify(normalizeAuditData(r.newData)).includes('"status":"PENDING_PAYMENT"')),
    };
}

async function wipe() {
    const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = hhs.map((h) => h.id);
    if (ids.length) {
        await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: ids } } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
}

describe('syncContractStatus', () => {
    const prevEnv = {
        id: process.env.ZOHO_CLIENT_ID,
        secret: process.env.ZOHO_CLIENT_SECRET,
        refresh: process.env.ZOHO_REFRESH_TOKEN,
    };

    beforeAll(async () => {
        // zohoConfigured() reads these three directly — set so the sync attempts a pull.
        process.env.ZOHO_CLIENT_ID = 'test-id';
        process.env.ZOHO_CLIENT_SECRET = 'test-secret';
        process.env.ZOHO_REFRESH_TOKEN = 'test-refresh';
        await wipe();
    });
    beforeEach(() => mockGetRequestStatus.mockReset());
    afterAll(async () => {
        await wipe();
        for (const [k, v] of [['ZOHO_CLIENT_ID', prevEnv.id], ['ZOHO_CLIENT_SECRET', prevEnv.secret], ['ZOHO_REFRESH_TOKEN', prevEnv.refresh]] as const) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        await prisma.$disconnect();
    });

    it('HAPPY: Zoho signed=true records contractSignedAt and (with bgConsent present) advances to PENDING_PAYMENT', async () => {
        const { userId, processId } = await makeApplicant({ bgConsentAt: new Date() });
        mockGetRequestStatus.mockResolvedValue('completed');

        const status = await syncContractStatus(userId);

        expect(status?.contractSigned).toBe(true);
        const p = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(p?.contractSignedAt).not.toBeNull();
        expect(p?.status).toBe('PENDING_PAYMENT');

        // Contract-signed audit is attributed to the signing applicant (actorId = userId).
        const a = await audits(processId);
        expect(a.signed).toHaveLength(1);
        expect(a.signed[0].actorId).toBe(userId);
        expect(a.advanced).toHaveLength(1);
    });

    it('HAPPY (no bg consent): records contractSignedAt but stays EXTERNAL', async () => {
        const { userId, processId } = await makeApplicant();
        mockGetRequestStatus.mockResolvedValue('completed');

        await syncContractStatus(userId);

        const p = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(p?.contractSignedAt).not.toBeNull();
        expect(p?.status).toBe('PENDING_EXTERNAL_ACTION');
    });

    it('NOT-YET-SIGNED: Zoho false leaves the process untouched', async () => {
        const { userId, processId } = await makeApplicant({ bgConsentAt: new Date() });
        mockGetRequestStatus.mockResolvedValue('in_progress');

        const status = await syncContractStatus(userId);

        expect(status?.contractSigned).toBe(false);
        const p = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(p?.contractSignedAt).toBeNull();
        expect(p?.status).toBe('PENDING_EXTERNAL_ACTION');
        const a = await audits(processId);
        expect(a.signed).toHaveLength(0);
    });

    it('IDEMPOTENT: a second sync after signing is a safe no-op (no double advance, no duplicate audit)', async () => {
        const { userId, processId } = await makeApplicant({ bgConsentAt: new Date() });
        mockGetRequestStatus.mockResolvedValue('completed');

        await syncContractStatus(userId);
        // Second call: Zoho would still say "signed", but the contract is already recorded.
        await syncContractStatus(userId);

        const p = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(p?.status).toBe('PENDING_PAYMENT');
        const a = await audits(processId);
        expect(a.signed).toHaveLength(1);
        expect(a.advanced).toHaveLength(1);
    });

    it('TERMINAL: a declined/expired request clears the stored Zoho ids so the next click starts fresh (#876)', async () => {
        const { userId, processId } = await makeApplicant({ zohoActionId: `act-${TAG}` });
        mockGetRequestStatus.mockResolvedValue('terminal');

        const status = await syncContractStatus(userId);

        // contractStarted resets — the UI offers a fresh "Sign" instead of a dead "Resume".
        expect(status?.contractSigned).toBe(false);
        expect(status?.contractStarted).toBe(false);
        const p = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(p?.zohoEnvelopeId).toBeNull();
        expect(p?.zohoActionId).toBeNull();
        expect(p?.contractSignedAt).toBeNull();
        expect(p?.status).toBe('PENDING_EXTERNAL_ACTION');
        const a = await audits(processId);
        expect(a.signed).toHaveLength(0);
    });

    it('ZOHO ERROR SWALLOWED: getRequestStatus throwing returns current status without throwing; process unchanged', async () => {
        const { userId, processId } = await makeApplicant({ bgConsentAt: new Date() });
        mockGetRequestStatus.mockRejectedValue(new Error('Zoho 503'));

        const status = await syncContractStatus(userId);

        expect(status).not.toBeNull();
        expect(status?.contractSigned).toBe(false);
        const p = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(p?.contractSignedAt).toBeNull();
        expect(p?.status).toBe('PENDING_EXTERNAL_ACTION');
    });

    it('returns null when the user has no in-flight EXTERNAL process', async () => {
        const { userId, processId } = await makeApplicant({ status: 'ACTIVE' });
        mockGetRequestStatus.mockResolvedValue('completed');

        expect(await syncContractStatus(userId)).toBeNull();
        // Zoho never consulted, nothing signed.
        expect(mockGetRequestStatus).not.toHaveBeenCalled();
        const p = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(p?.contractSignedAt).toBeNull();
    });

    it('sync route rejects an unauthenticated request (401)', async () => {
        (getServerSession as jest.Mock).mockResolvedValue(null);
        const req = new Request('http://localhost:4000/api/membership/contract/sync', { method: 'POST' });
        const res = await SYNC_ROUTE(req as never);
        expect(res.status).toBe(401);
    });
});
