/**
 * @jest-environment node
 */
/**
 * A signature that lands while an application is closed: the webhook cannot match a
 * closed application, so reopening and "Resume signing" ask Zoho for it instead.
 *
 * Zoho is mocked; none of this has run against real Zoho.
 */

import { archiveApplication, unarchiveApplication } from '@/lib/membership/archive';
import { findProcessByEnvelope, getOrCreateContractSigningUrl } from '@/lib/membership/external';
import { SYSTEM_ACTOR } from '@/lib/auditActor';
import { normalizeAuditData } from '@/lib/auditPayload';
import { createRequest, getEmbeddedSignUrl, getRequestStatus } from '@/lib/membership/contract/zohoClient';
import prisma from '@/lib/prisma';

jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));
jest.mock('@/lib/membership/contract/zohoClient', () => ({
    getAccessToken: jest.fn().mockResolvedValue('test-token'),
    getRequestStatus: jest.fn(),
    createRequest: jest.fn(),
    submitRequest: jest.fn(),
    getEmbeddedSignUrl: jest.fn(),
}));

const mockGetRequestStatus = getRequestStatus as jest.Mock;
const mockGetEmbeddedSignUrl = getEmbeddedSignUrl as jest.Mock;
const mockCreateRequest = createRequest as jest.Mock;

const TAG = 'closed-signature-test';

async function makePerson(role: string, data: { householdId?: number; isHouseholdLead?: boolean } = {}) {
    const householdId = data.householdId ?? (await prisma.household.create({ data: { name: `${role} ${TAG}` } })).id;
    return prisma.person.create({ data: { email: `${role}-${crypto.randomUUID()}-${TAG}@example.com`, name: role, ...data, householdId } });
}

/** A household whose lead has an open signing request, closed by a board member from outside it. */
async function closedApplication(data: Record<string, unknown> = {}) {
    const household = await prisma.household.create({ data: { name: `Applicant ${TAG}` } });
    const membership = await prisma.orgMembership.create({ data: { householdId: household.id, status: 'NONE' } });
    const lead = await makePerson('lead', { householdId: household.id, isHouseholdLead: true });
    const requestId = `zoho-${crypto.randomUUID()}`;
    const process = await prisma.orgMembershipProcess.create({
        data: {
            orgMembershipId: membership.id,
            kind: 'INITIAL',
            status: 'PENDING_EXTERNAL_ACTION',
            zohoEnvelopeId: requestId,
            zohoActionId: `act-${requestId}`,
            zohoSignerPersonId: lead.id,
            ...data,
        },
    });
    const board = await makePerson('board');
    await archiveApplication(process.id, board.id);
    return { processId: process.id, requestId, leadId: lead.id, boardId: board.id };
}

const read = (id: number) => prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id } });

async function signatureAudits(processId: number) {
    const rows = await prisma.auditLog.findMany({
        where: { tableName: 'OrgMembershipProcess', affectedEntityId: processId },
        select: { actorId: true, actorSystem: true, newData: true },
    });
    return rows.filter((r) => JSON.stringify(normalizeAuditData(r.newData)).includes('"contractSignedAt":true'));
}

async function wipe() {
    const households = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = households.map((h) => h.id);
    await prisma.orgMembershipProcess.deleteMany({
        where: { OR: [{ orgMembership: { householdId: { in: ids } } }, { subjectPerson: { email: { contains: TAG } } }] },
    });
    await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
    await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
    await prisma.household.deleteMany({ where: { id: { in: ids } } });
}

describe('a signature that lands while the application is closed', () => {
    const prevEnv = {
        id: process.env.ZOHO_CLIENT_ID,
        secret: process.env.ZOHO_CLIENT_SECRET,
        refresh: process.env.ZOHO_REFRESH_TOKEN,
    };

    beforeAll(async () => {
        process.env.ZOHO_CLIENT_ID = 'test-id';
        process.env.ZOHO_CLIENT_SECRET = 'test-secret';
        process.env.ZOHO_REFRESH_TOKEN = 'test-refresh';
        await wipe();
    });
    beforeEach(() => {
        mockGetRequestStatus.mockReset();
        mockGetEmbeddedSignUrl.mockReset();
        mockCreateRequest.mockReset();
    });
    afterAll(async () => {
        await wipe();
        for (const [k, v] of [['ZOHO_CLIENT_ID', prevEnv.id], ['ZOHO_CLIENT_SECRET', prevEnv.secret], ['ZOHO_REFRESH_TOKEN', prevEnv.refresh]] as const) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        await prisma.$disconnect();
    });

    it('is recorded at reopen and advances the application, naming the signer and not the board member', async () => {
        const { processId, requestId, leadId, boardId } = await closedApplication({ bgConsentAt: new Date() });
        expect(await findProcessByEnvelope(requestId)).toBeNull();
        mockGetRequestStatus.mockResolvedValue('completed');

        await expect(unarchiveApplication(processId, boardId)).resolves.toEqual({ status: 'PENDING_PAYMENT' });

        const row = await read(processId);
        expect(row.contractSignedAt).not.toBeNull();
        expect(row.zohoSignerPersonId).toBe(leadId);
        const audits = await signatureAudits(processId);
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({ actorId: SYSTEM_ACTOR, actorSystem: 'webhook:zoho-contract' });
    });

    it('Zoho down at reopen: the reopen succeeds and "Resume signing" records the signature without minting a link', async () => {
        const { processId, leadId, boardId } = await closedApplication();
        mockGetRequestStatus.mockRejectedValueOnce(new Error('Zoho 503'));

        await expect(unarchiveApplication(processId, boardId)).resolves.toEqual({ status: 'PENDING_EXTERNAL_ACTION' });
        expect((await read(processId)).contractSignedAt).toBeNull();

        mockGetRequestStatus.mockResolvedValue('completed');
        await expect(getOrCreateContractSigningUrl(leadId)).rejects.toMatchObject({ code: 'wrong_phase', message: expect.stringMatching(/already been signed/) });

        expect((await read(processId)).contractSignedAt).not.toBeNull();
        expect(mockGetEmbeddedSignUrl).not.toHaveBeenCalled();
        expect(mockCreateRequest).not.toHaveBeenCalled();
    });

    it('Zoho still waiting: reopen leaves the request alone and "Resume signing" mints a link for it', async () => {
        const { processId, requestId, leadId, boardId } = await closedApplication();
        mockGetRequestStatus.mockResolvedValue('in_progress');
        mockGetEmbeddedSignUrl.mockResolvedValue('https://sign.example/resume');

        await unarchiveApplication(processId, boardId);
        const row = await read(processId);
        expect(row.contractSignedAt).toBeNull();
        expect(row.zohoEnvelopeId).toBe(requestId);

        await expect(getOrCreateContractSigningUrl(leadId)).resolves.toBe('https://sign.example/resume');
    });

    it('a declined or expired request is untouched by reopen', async () => {
        const { processId, requestId, boardId } = await closedApplication();
        mockGetRequestStatus.mockResolvedValue('terminal');

        await expect(unarchiveApplication(processId, boardId)).resolves.toEqual({ status: 'PENDING_EXTERNAL_ACTION' });

        const row = await read(processId);
        expect(row.contractSignedAt).toBeNull();
        expect(row.zohoEnvelopeId).toBe(requestId);
    });

    it('a closed individual agreement signed at Zoho completes when reopened', async () => {
        const subject = await makePerson('subject');
        const board = await makePerson('board');
        const requestId = `zoho-${crypto.randomUUID()}`;
        const process = await prisma.orgMembershipProcess.create({
            data: { kind: 'PERSON_AGREEMENT', status: 'PENDING_EXTERNAL_ACTION', subjectPersonId: subject.id, zohoEnvelopeId: requestId, zohoActionId: `act-${requestId}` },
        });
        await archiveApplication(process.id, board.id);
        mockGetRequestStatus.mockResolvedValue('completed');

        await unarchiveApplication(process.id, board.id);

        const row = await read(process.id);
        expect(row.contractSignedAt).not.toBeNull();
        expect(row.status).toBe('ACTIVE');
    });
});
