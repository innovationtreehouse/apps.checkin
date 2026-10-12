/**
 * @jest-environment node
 */
/**
 * Integration tests for POST /api/membership/contract/sign — the applicant-facing
 * "Sign your membership agreement" action. The Zoho client and the agreement-PDF
 * loader are mocked (no real Zoho calls / no PDF on disk); the DB and the
 * idempotent create-and-store logic are exercised for real.
 */

import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import * as zoho from '@/lib/membership/contract/zohoClient';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/membership/contract/agreementDocument', () => ({
    ...jest.requireActual('@/lib/membership/contract/agreementDocument'),
    loadAgreementPdf: jest.fn().mockResolvedValue({ pdf: Buffer.from('%PDF-1.4'), lastPageNo: 0, pageWidth: 612, pageHeight: 792 }),
    // Dev watermark step re-parses the stub PDF (not a real PDF) → passthrough so it doesn't crash.
    stampWatermark: jest.fn(async (pdf) => pdf),
}));
jest.mock('@/lib/membership/contract/zohoClient', () => ({
    ZohoError: class ZohoError extends Error {},
    getAccessToken: jest.fn().mockResolvedValue('tok'),
    createRequest: jest.fn().mockResolvedValue({ requestId: 'REQ-1', actionId: 'ACT-1', documentId: 'DOC-1' }),
    submitRequest: jest.fn().mockResolvedValue(undefined),
    getEmbeddedSignUrl: jest.fn().mockResolvedValue('https://sign.zoho.com/embed/xyz'),
    getRequestStatus: jest.fn().mockResolvedValue('in_progress'),
    recallRequest: jest.fn().mockResolvedValue(undefined),
}));

// Imported AFTER the mocks so the route picks up the mocked client.
import { POST as SIGN } from '@/app/api/membership/contract/sign/route';
import { POST as BOARD_EXTERNAL } from '@/app/api/membership-ops/applications/external/route';
import { GET as HOUSEHOLD_GET } from '@/app/api/membership-ops/households/route';
// loadAgreementPdf is the jest.fn from the mock above; AgreementUnavailableError is
// the real class (requireActual spread) so `instanceof` in external.ts matches.
import { loadAgreementPdf, AgreementUnavailableError } from '@/lib/membership/contract/agreementDocument';

const TAG = 'contract-sign-test';

function asUser(id: number) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isSysadmin: false, isBoardMember: false } });
}
function signReq() {
    return new Request('http://localhost:4000/api/membership/contract/sign', { method: 'POST' }) as unknown as Parameters<typeof SIGN>[0];
}

describe('POST /api/membership/contract/sign', () => {
    let leadId: number;
    let nonLeadId: number;
    let processId: number;
    const prevEnv = { id: process.env.ZOHO_CLIENT_ID, secret: process.env.ZOHO_CLIENT_SECRET, refresh: process.env.ZOHO_REFRESH_TOKEN };

    async function wipe() {
        const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const ids = hhs.map((h) => h.id);
        if (ids.length) {
            await prisma.auditLog.deleteMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: { in: ids } } }).catch(() => {});
            await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: ids } } } });
            await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.household.deleteMany({ where: { id: { in: ids } } });
        }
    }

    beforeAll(async () => {
        process.env.ZOHO_CLIENT_ID = 'cid';
        process.env.ZOHO_CLIENT_SECRET = 'csecret';
        process.env.ZOHO_REFRESH_TOKEN = 'rtoken';
        await wipe();

        const hh = await prisma.household.create({ data: { name: `HH ${TAG}` } });
        const lead = await prisma.person.create({ data: { email: `lead-${TAG}@example.com`, name: 'Lead Parent', householdId: hh.id } });
        const nonLead = await prisma.person.create({ data: { email: `member-${TAG}@example.com`, name: 'Member', householdId: hh.id } });
        await prisma.person.update({ where: { id: lead.id }, data: { isHouseholdLead: true } });
        const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
        const proc = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.id, kind: 'INITIAL', status: 'PENDING_EXTERNAL_ACTION' } });
        leadId = lead.id;
        nonLeadId = nonLead.id;
        processId = proc.id;
    });

    afterAll(async () => {
        await wipe();
        process.env.ZOHO_CLIENT_ID = prevEnv.id;
        process.env.ZOHO_CLIENT_SECRET = prevEnv.secret;
        process.env.ZOHO_REFRESH_TOKEN = prevEnv.refresh;
        await prisma.$disconnect();
    });

    beforeEach(() => jest.clearAllMocks());

    it('rejects a non-lead household member', async () => {
        asUser(nonLeadId);
        const res = await SIGN(signReq());
        expect(res.status).toBe(403);
        expect(zoho.createRequest).not.toHaveBeenCalled();
    });

    it('creates the Zoho request once, stores the ids, and returns the embed url', async () => {
        asUser(leadId);
        const res = await SIGN(signReq());
        expect(res.status).toBe(200);
        expect((await res.json()).url).toBe('https://sign.zoho.com/embed/xyz');
        expect(zoho.createRequest).toHaveBeenCalledTimes(1);
        // PrintedName is prefilled from the applicant's name.
        expect((zoho.submitRequest as jest.Mock).mock.calls[0][0].prefill).toEqual({ PrintedName: 'Lead Parent' });
        const p = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(p?.zohoEnvelopeId).toBe('REQ-1');
        expect(p?.zohoActionId).toBe('ACT-1');
    });

    it('is idempotent: a second click reuses the stored request, only minting a fresh url', async () => {
        asUser(leadId);
        const res = await SIGN(signReq());
        expect(res.status).toBe(200);
        expect(zoho.createRequest).not.toHaveBeenCalled(); // already created last test
        expect(zoho.getEmbeddedSignUrl).toHaveBeenCalledTimes(1);
        const p = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(p?.zohoEnvelopeId).toBe('REQ-1'); // unchanged
    });

    it('lets a RENEWAL process in the EXTERNAL phase sign (renewals re-sign fresh)', async () => {
        const hh = await prisma.household.create({ data: { name: `HH renewal ${TAG}` } });
        const rLead = await prisma.person.create({ data: { email: `rlead-${TAG}@example.com`, name: 'Renewing Lead', householdId: hh.id } });
        await prisma.person.update({ where: { id: rLead.id }, data: { isHouseholdLead: true } });
        const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'ACTIVE' } });
        await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.id, kind: 'RENEWAL', status: 'PENDING_EXTERNAL_ACTION' } });

        asUser(rLead.id);
        const res = await SIGN(signReq());
        expect(res.status).toBe(200);
        expect(zoho.createRequest).toHaveBeenCalledTimes(1);
    });

    it('survives two concurrent clicks: creates ONE Zoho request (claim first) and embeds only that id', async () => {
        // Distinct ids per create so a double-create would be detectable.
        let n = 0;
        (zoho.createRequest as jest.Mock).mockImplementation(async () => {
            n += 1;
            return { requestId: `REQ-C${n}`, actionId: `ACT-C${n}`, documentId: `DOC-C${n}` };
        });
        await prisma.orgMembershipProcess.update({ where: { id: processId }, data: { zohoEnvelopeId: null, zohoActionId: null, zohoSignerPersonId: null } });
        asUser(leadId);

        const [r1, r2] = await Promise.all([SIGN(signReq()), SIGN(signReq())]);
        // The claim's loser either reuses the stored request or is told to wait.
        const statuses = [r1.status, r2.status].sort();
        expect(statuses[0]).toBe(200);
        expect([200, 409]).toContain(statuses[1]);
        // Zoho bills per request: the claim lets only one click create.
        expect(zoho.createRequest).toHaveBeenCalledTimes(1);

        // Every embed URL was minted against the one stored request.
        const p = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(p?.zohoEnvelopeId).toBeTruthy();
        expect(p?.zohoActionId).toBeTruthy();
        for (const call of (zoho.getEmbeddedSignUrl as jest.Mock).mock.calls) {
            expect(call[0].requestId).toBe(p?.zohoEnvelopeId);
            expect(call[0].actionId).toBe(p?.zohoActionId);
        }

        // Restore the default create mock + a stored request for later assertions.
        (zoho.createRequest as jest.Mock).mockResolvedValue({ requestId: 'REQ-1', actionId: 'ACT-1', documentId: 'DOC-1' });
        await prisma.orgMembershipProcess.update({ where: { id: processId }, data: { zohoEnvelopeId: 'REQ-1', zohoActionId: 'ACT-1' } });
    });

    it('recovers when an envelope id was stored without an action id (legacy admin/email flow)', async () => {
        // setZohoEnvelope stores zohoEnvelopeId WITHOUT an action id — that pair
        // can't be embedded, so the in-app flow must re-create and overwrite it
        // rather than 409 forever on the incomplete pair.
        await prisma.orgMembershipProcess.update({ where: { id: processId }, data: { zohoEnvelopeId: 'LEGACY-ENV', zohoActionId: null, zohoSignerPersonId: null } });
        asUser(leadId);
        const res = await SIGN(signReq());
        expect(res.status).toBe(200);
        expect(zoho.createRequest).toHaveBeenCalledTimes(1);
        const p = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(p?.zohoEnvelopeId).toBe('REQ-1'); // overwritten with the embeddable request
        expect(p?.zohoActionId).toBe('ACT-1');
    });

    it('recreates a fresh request when the stored one is dead — declined or expired (#876)', async () => {
        await prisma.orgMembershipProcess.update({ where: { id: processId }, data: { zohoEnvelopeId: 'DEAD-REQ', zohoActionId: 'DEAD-ACT' } });
        (zoho.getRequestStatus as jest.Mock).mockResolvedValueOnce('terminal');

        asUser(leadId);
        const res = await SIGN(signReq());
        expect(res.status).toBe(200);
        expect((await res.json()).url).toBe('https://sign.zoho.com/embed/xyz');
        // The dead ids were forgotten and a fresh request created + stored.
        expect(zoho.createRequest).toHaveBeenCalledTimes(1);
        const p = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(p?.zohoEnvelopeId).toBe('REQ-1');
        expect(p?.zohoActionId).toBe('ACT-1');
    });

    it('falls back to the stored request when the status check fails (best-effort)', async () => {
        (zoho.getRequestStatus as jest.Mock).mockRejectedValueOnce(new Error('Zoho 503'));

        asUser(leadId);
        const res = await SIGN(signReq());
        expect(res.status).toBe(200);
        // No re-create: the stored request is reused exactly as before the check existed.
        expect(zoho.createRequest).not.toHaveBeenCalled();
        expect((zoho.getEmbeddedSignUrl as jest.Mock).mock.calls[0][0].requestId).toBe('REQ-1');
        const p = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(p?.zohoEnvelopeId).toBe('REQ-1');
    });

    it('lets a isSysadmin who is NOT a household lead sign (isSysadmin bypass)', async () => {
        // Household whose lead is someone else; the signer is a isSysadmin member, not a lead.
        const hh = await prisma.household.create({ data: { name: `HH isSysadmin ${TAG}` } });
        const otherLead = await prisma.person.create({ data: { email: `otherlead-${TAG}@example.com`, name: 'Other Lead', householdId: hh.id } });
        await prisma.person.update({ where: { id: otherLead.id }, data: { isHouseholdLead: true } });
        const isSysadmin = await prisma.person.create({ data: { email: `isSysadmin-${TAG}@example.com`, name: 'Sys Admin', householdId: hh.id, isSysadmin: true } });
        const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
        await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.id, kind: 'INITIAL', status: 'PENDING_EXTERNAL_ACTION' } });

        asUser(isSysadmin.id); // session isSysadmin flag is irrelevant; the service reads the DB row
        const res = await SIGN(signReq());
        expect(res.status).toBe(200);
        expect(zoho.createRequest).toHaveBeenCalledTimes(1); // passed the not_lead gate
    });

    it('503s (agreement_unavailable) when the agreement PDF cannot be loaded', async () => {
        // Fresh process with no stored Zoho ids → the route takes the create path,
        // which loads the agreement PDF; make that throw AgreementUnavailableError.
        const hh = await prisma.household.create({ data: { name: `HH noagreement ${TAG}` } });
        const lead = await prisma.person.create({ data: { email: `noagr-lead-${TAG}@example.com`, name: 'NoAgr Lead', householdId: hh.id } });
        await prisma.person.update({ where: { id: lead.id }, data: { isHouseholdLead: true } });
        const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
        await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.id, kind: 'INITIAL', status: 'PENDING_EXTERNAL_ACTION' } });

        (loadAgreementPdf as jest.Mock).mockRejectedValueOnce(new AgreementUnavailableError('not ready'));

        asUser(lead.id);
        const res = await SIGN(signReq());
        expect(res.status).toBe(503);
        expect((await res.json()).code).toBe('agreement_unavailable');
        // Failed before reaching Zoho's create.
        expect(zoho.createRequest).not.toHaveBeenCalled();
    });

    it('409s when the application is not in the EXTERNAL phase', async () => {
        await prisma.orgMembershipProcess.update({ where: { id: processId }, data: { status: 'INTAKE' } });
        asUser(leadId);
        const res = await SIGN(signReq());
        expect(res.status).toBe(409);
        await prisma.orgMembershipProcess.update({ where: { id: processId }, data: { status: 'PENDING_EXTERNAL_ACTION' } });
    });

    it('503s when Zoho is not configured (prod — the dev mock is dead here)', async () => {
        delete process.env.ZOHO_CLIENT_ID;
        // The dev/local mock stands in when Zoho is unconfigured (→ 200), so the
        // unconfigured-503 contract is prod-only. Pin CHECKIN_ENV=prod to assert it.
        const prevEnv = process.env.CHECKIN_ENV;
        process.env.CHECKIN_ENV = 'prod';
        asUser(leadId);
        const res = await SIGN(signReq());
        expect(res.status).toBe(503);
        process.env.ZOHO_CLIENT_ID = 'cid';
        process.env.CHECKIN_ENV = prevEnv;
    });

    // Zoho is pay-as-you-go: a second lead never gets a request while the first
    // lead's is open; only a board reset frees it, and the new request is theirs.
    it('a second lead is refused while the first lead\'s request is open, until the board resets signing', async () => {
        const hh = await prisma.household.create({ data: { name: `HH two-lead ${TAG}` } });
        const leadA = await prisma.person.create({ data: { email: `lead-a-${TAG}@example.com`, name: 'Alex Lead', householdId: hh.id, isHouseholdLead: true } });
        const leadB = await prisma.person.create({ data: { email: `lead-b-${TAG}@example.com`, name: 'Blair Lead', householdId: hh.id, isHouseholdLead: true } });
        const boardHh = await prisma.household.create({ data: { name: `HH board ${TAG}` } });
        const board = await prisma.person.create({ data: { email: `board-${TAG}@example.com`, name: 'Board Person', isBoardMember: true, householdId: boardHh.id } });
        const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
        const proc = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.id, kind: 'INITIAL', status: 'PENDING_EXTERNAL_ACTION' } });
        (zoho.createRequest as jest.Mock)
            .mockResolvedValueOnce({ requestId: 'REQ-A', actionId: 'ACT-A', documentId: 'DOC-A' })
            .mockResolvedValueOnce({ requestId: 'REQ-B', actionId: 'ACT-B', documentId: 'DOC-B' });

        asUser(leadA.id);
        expect((await SIGN(signReq())).status).toBe(200);
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: proc.id } }))?.zohoSignerPersonId).toBe(leadA.id);

        asUser(leadB.id);
        const refused = await SIGN(signReq());
        expect(refused.status).toBe(409);
        expect(await refused.json()).toMatchObject({
            code: 'signing_in_progress',
            error: 'Alex Lead started signing. Ask Alex Lead to finish, or ask the board to reset the signing so you can sign.',
        });
        expect(zoho.createRequest).toHaveBeenCalledTimes(1);

        // The board's household detail shows who the open request is addressed to.
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: board.id, isSysadmin: false, isBoardMember: true } });
        const householdReq = new Request(`http://localhost:4000/api/membership-ops/households?id=${hh.id}`) as unknown as Parameters<typeof HOUSEHOLD_GET>[0];
        expect((await (await HOUSEHOLD_GET(householdReq)).json()).signing).toMatchObject({
            processId: proc.id, contractStarted: true, signerName: 'Alex Lead', contractSignedAt: null,
        });
        const boardReq = (body: object) => new Request('http://localhost:4000/api/membership-ops/applications/external', {
            method: 'POST', body: JSON.stringify(body),
        }) as unknown as Parameters<typeof BOARD_EXTERNAL>[0];
        expect((await BOARD_EXTERNAL(boardReq({ processId: proc.id, action: 'reset-signing' }))).status).toBe(400); // reason required
        expect((await BOARD_EXTERNAL(boardReq({ processId: proc.id, action: 'reset-signing', reason: 'Alex is away' }))).status).toBe(200);
        expect(zoho.recallRequest).toHaveBeenCalledWith('tok', 'REQ-A');
        const reset = await prisma.orgMembershipProcess.findUnique({ where: { id: proc.id } });
        expect(reset).toMatchObject({ zohoEnvelopeId: null, zohoActionId: null, zohoSignerPersonId: null });

        asUser(leadB.id);
        expect((await SIGN(signReq())).status).toBe(200);
        expect(zoho.createRequest).toHaveBeenCalledTimes(2);
        expect((zoho.submitRequest as jest.Mock).mock.calls.at(-1)[0].prefill).toEqual({ PrintedName: 'Blair Lead' });
        expect(await prisma.orgMembershipProcess.findUnique({ where: { id: proc.id } })).toMatchObject({ zohoEnvelopeId: 'REQ-B', zohoSignerPersonId: leadB.id });
        await prisma.auditLog.deleteMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: proc.id } });
    });

    it('the board cannot reset signing on its own household', async () => {
        const hh = await prisma.household.create({ data: { name: `HH own ${TAG}` } });
        const lead = await prisma.person.create({ data: { email: `lead-own-${TAG}@example.com`, name: 'Own Lead', householdId: hh.id, isHouseholdLead: true, isBoardMember: true } });
        const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
        const proc = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.id, kind: 'INITIAL', status: 'PENDING_EXTERNAL_ACTION', zohoEnvelopeId: 'REQ-OWN', zohoActionId: 'ACT-OWN' } });

        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: lead.id, isSysadmin: false, isBoardMember: true } });
        const res = await BOARD_EXTERNAL(new Request('http://localhost:4000/api/membership-ops/applications/external', {
            method: 'POST', body: JSON.stringify({ processId: proc.id, action: 'reset-signing', reason: 'mine' }),
        }) as unknown as Parameters<typeof BOARD_EXTERNAL>[0]);
        expect(res.status).toBe(403);
        expect(zoho.recallRequest).not.toHaveBeenCalled();
    });
});
