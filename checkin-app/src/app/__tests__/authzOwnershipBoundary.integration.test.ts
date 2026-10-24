/**
 * @jest-environment node
 */
/**
 * Ownership/privilege-boundary tests for the `withAuth({})` routes that enforce
 * ownership INSIDE the handler (auth-only at the wrapper, so the wrapper never
 * returns 403 — the gate is a DB lookup in the handler/service). These are the
 * routes most likely to silently regress into an IDOR. For each we assert:
 *   - unauthenticated            -> 401
 *   - authenticated NON-owner    -> 403  (or, for self-scoped routes with no id
 *                                          param, that the caller cannot reach
 *                                          another household's data)
 *   - owner                      -> 2xx
 *
 * TEST-ONLY. A non-owner reaching 2xx (or another household's data) is a live
 * IDOR/authz hole — the failing assertion documents it.
 *
 * Fixtures:
 *   HH_A   — leadA (lead) + memberA (in the household, NOT a lead). memberA is
 *            the in-household non-lead used to prove the lead-only gate.
 *   HH_B   — leadB (lead of a DIFFERENT household). The cross-household attacker
 *            used to prove the id-addressed trusted-adult routes reject a lead
 *            of the wrong household.
 *   HH_PAY        — payLead (lead) + payMember (NOT a lead); membership process
 *                   PENDING_PAYMENT.
 *   HH_RENEWAL    — renewalLead (lead); membership process PENDING_RENEWAL (read-only:
 *                   renewal-status).
 *   HH_RENEW      — renewUser; membership process PENDING_RENEWAL (mutated by renew).
 */
import { PATCH as SETTINGS_PATCH } from '@/app/api/household/settings/route';
import { GET as EC_GET, POST as EC_POST } from '@/app/api/household/emergency-contacts/route';
import { PATCH as EC_PATCH, DELETE as EC_DELETE } from '@/app/api/household/emergency-contacts/[contactId]/route';
import { POST as TA_WITHDRAW } from '@/app/api/trusted-adults/[id]/withdraw/route';
import { POST as TA_RENEW } from '@/app/api/trusted-adults/[id]/renew/route';
import { GET as PAYMENT_GET } from '@/app/api/membership/payment/route';
import { POST as RENEW_POST } from '@/app/api/membership/renew/route';
import { GET as RENEWAL_STATUS_GET } from '@/app/api/membership/renewal-status/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));

const TAG = 'authz-ownership-test';

function as(id: number, extra: Record<string, unknown> = {}) {
    (getServerSession as jest.Mock).mockResolvedValue({
        user: { id, isSysadmin: false, isBoardMember: false, isKeyholder: false, isBackgroundCheckReviewer: false, ...extra },
    });
}
function anon() {
    (getServerSession as jest.Mock).mockResolvedValue(null);
}
function req(url = 'http://localhost/', init?: RequestInit) {
    return new Request(url, init) as never;
}
function jsonReq(body: unknown, method = 'PATCH') {
    return new Request('http://localhost/x', { method, body: JSON.stringify(body) }) as never;
}
function ecCtx(contactId: number) {
    return { params: Promise.resolve({ contactId: String(contactId) }) } as never;
}
// The trusted-adult routes read the id from req.nextUrl.pathname.split('/').at(-2).
// next/server is mocked in jest.setup (only NextResponse.json), so NextRequest is
// unavailable — build a plain Request and attach nextUrl ourselves.
function taReq(id: number, action: 'withdraw' | 'renew') {
    const r = new Request(`http://localhost/api/trusted-adults/${id}/${action}`, { method: 'POST' });
    (r as unknown as { nextUrl: URL }).nextUrl = new URL(r.url);
    return r as never;
}
// Post-403 no-mutation probes for the trusted-adult IDOR cases. A 403 alone does
// not prove the row was untouched — a guard that ran AFTER a write would still
// 403. Re-read the latest review's status, the review count (renew must not open
// a new one), and the TrustedAdult audit-row count (a write would log one).
function latestReviewStatus(taId: number) {
    return prisma.trustedAdultReview
        .findFirst({ where: { trustedAdultId: taId }, orderBy: { id: 'desc' }, select: { status: true } })
        .then((r) => r?.status);
}
function reviewCount(taId: number) {
    return prisma.trustedAdultReview.count({ where: { trustedAdultId: taId } });
}
function taAuditCount(taId: number) {
    return prisma.auditLog.count({ where: { tableName: 'TrustedAdult', affectedEntityId: taId } });
}

describe('Ownership-boundary authorization', () => {
    let leadA = 0, memberA = 0, hhA = 0;
    let leadB = 0, hhB = 0;
    let payLead = 0, payMember = 0, hhPay = 0;
    let renewalLead = 0, hhRenewal = 0;
    let renewUser = 0, hhRenew = 0;
    let taWithdrawId = 0, taRenewId = 0;
    let contact1 = 0, contact2 = 0;

    async function wipe() {
        const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const ids = hhs.map((h) => h.id);
        if (ids.length) {
            await prisma.trustedAdultReview.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.trustedAdult.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.emergencyContact.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.auditLog.deleteMany({ where: { tableName: 'EmergencyContact', secondaryAffectedEntity: { in: ids } } });
            await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: ids } } } });
            await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.household.deleteMany({ where: { id: { in: ids } } });
        }
    }

    async function mkHousehold(label: string) {
        return (await prisma.household.create({ data: { name: `${label} ${TAG}` } })).id;
    }
    async function mkMember(householdId: number, name: string, lead = false) {
        const p = await prisma.person.create({ data: { name: `${name} ${TAG}`, householdId } });
        if (lead) await prisma.person.update({ where: { id: p.id }, data: { isHouseholdLead: true } });
        return p.id;
    }
    async function mkPendingProcess(householdId: number, status: 'PENDING_PAYMENT' | 'PENDING_RENEWAL', kind: 'INITIAL' | 'RENEWAL') {
        const m = await prisma.orgMembership.create({ data: { householdId, status: 'NONE', isVolunteerFamily: false } });
        await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.id, kind, status } });
    }

    beforeAll(async () => {
        await wipe();

        hhA = await mkHousehold('HH_A');
        leadA = await mkMember(hhA, 'LeadA', true);
        memberA = await mkMember(hhA, 'MemberA');

        hhB = await mkHousehold('HH_B');
        leadB = await mkMember(hhB, 'LeadB', true);

        hhPay = await mkHousehold('HH_PAY');
        payLead = await mkMember(hhPay, 'PayLead', true);
        payMember = await mkMember(hhPay, 'PayMember');
        await mkPendingProcess(hhPay, 'PENDING_PAYMENT', 'INITIAL');

        hhRenewal = await mkHousehold('HH_RENEWAL');
        renewalLead = await mkMember(hhRenewal, 'RenewalLead', true);
        await mkPendingProcess(hhRenewal, 'PENDING_RENEWAL', 'RENEWAL');

        hhRenew = await mkHousehold('HH_RENEW');
        renewUser = await mkMember(hhRenew, 'RenewUser', true);
        await mkPendingProcess(hhRenew, 'PENDING_RENEWAL', 'RENEWAL');

        // Trusted adults owned by HH_A.
        const taW = await prisma.trustedAdult.create({
            data: {
                householdId: hhA, trustedAdultName: 'Aunt May', trustedAdultPhone: '555-555-0001',
                familyContext: 'ctx', disclosedById: leadA,
                reviews: { create: { householdId: hhA, kind: 'INITIAL', status: 'PENDING_BOARD_REVIEW' } },
            },
        });
        taWithdrawId = taW.id;
        const taR = await prisma.trustedAdult.create({
            data: {
                householdId: hhA, trustedAdultName: 'Uncle Ben', trustedAdultPhone: '555-555-0002',
                familyContext: 'ctx', disclosedById: leadA,
                reviews: { create: { householdId: hhA, kind: 'INITIAL', status: 'APPROVED' } },
            },
        });
        taRenewId = taR.id;

        // Two emergency contacts in HH_A (DELETE needs a second valid contact to exist).
        as(leadA, { householdId: hhA });
        contact1 = (await (await EC_POST(jsonReq({ name: 'Contact One', phone: '555-555-1111' }, 'POST'))).json()).contact.id;
        contact2 = (await (await EC_POST(jsonReq({ name: 'Contact Two', phone: '555-555-2222' }, 'POST'))).json()).contact.id;
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    beforeEach(() => jest.clearAllMocks());

    // ---- household/settings (PATCH) — lead-only --------------------------------
    describe('PATCH /api/household/settings', () => {
        // A complete address: assertValidAddress (structured addresses, #513) rejects
        // a partial address (400) before this route's lead-only authz check even runs.
        const body = { line1: '1 New St', city: 'Anytown', state: 'CA', postalCode: '90210' };
        it('401 unauthenticated', async () => {
            anon();
            expect((await SETTINGS_PATCH(jsonReq(body))).status).toBe(401);
        });
        it('403 for a non-lead member of the household', async () => {
            as(memberA, { householdId: hhA });
            expect((await SETTINGS_PATCH(jsonReq(body))).status).toBe(403);
        });
        it('200 for the household lead', async () => {
            as(leadA, { householdId: hhA });
            expect((await SETTINGS_PATCH(jsonReq(body))).status).toBe(200);
        });
    });

    // ---- household/emergency-contacts (GET, POST) — lead-only ------------------
    describe('GET/POST /api/household/emergency-contacts', () => {
        it('401 unauthenticated (GET)', async () => {
            anon();
            expect((await EC_GET(req())).status).toBe(401);
        });
        it('403 for a non-lead member (GET — emergency-contact PII)', async () => {
            as(memberA, { householdId: hhA });
            expect((await EC_GET(req())).status).toBe(403);
        });
        it('403 for a non-lead member (POST)', async () => {
            as(memberA, { householdId: hhA });
            expect((await EC_POST(jsonReq({ name: 'X', phone: '555-555-0009' }, 'POST'))).status).toBe(403);
        });
        it('200 for the lead (GET)', async () => {
            as(leadA, { householdId: hhA });
            expect((await EC_GET(req())).status).toBe(200);
        });
    });

    // ---- household/emergency-contacts/[contactId] (PATCH, DELETE) — lead-only --
    describe('PATCH/DELETE /api/household/emergency-contacts/[contactId]', () => {
        it('401 unauthenticated (PATCH)', async () => {
            anon();
            expect((await EC_PATCH(jsonReq({ name: 'Z' }), ecCtx(contact1))).status).toBe(401);
        });
        it('403 for a non-lead member (PATCH)', async () => {
            as(memberA, { householdId: hhA });
            expect((await EC_PATCH(jsonReq({ name: 'Z' }), ecCtx(contact1))).status).toBe(403);
        });
        it('403 for a non-lead member (DELETE)', async () => {
            as(memberA, { householdId: hhA });
            expect((await EC_DELETE(req('http://localhost/x', { method: 'DELETE' }), ecCtx(contact1))).status).toBe(403);
        });
        it('a lead of a DIFFERENT household cannot edit this contact (404, not 200 — and the contact is untouched)', async () => {
            as(leadB, { householdId: hhB });
            // leadB is a lead (passes the lead gate for THEIR household) but the contact
            // belongs to HH_A — the service must not find/update it for HH_B. A 404 alone
            // doesn't prove the row was untouched (a guard that ran AFTER the write would
            // still 404); re-read and compare. Mirrors fd192fc.
            const before = await prisma.emergencyContact.findUnique({ where: { id: contact1 } });
            const res = await EC_PATCH(jsonReq({ name: 'Hijack', phone: '555-555-6666' }), ecCtx(contact1));
            expect(res.status).not.toBe(200);
            expect(res.status).toBe(404);
            const after = await prisma.emergencyContact.findUnique({ where: { id: contact1 } });
            expect(after?.name).toBe(before?.name);
            expect(after?.phone).toBe(before?.phone);
        });
        it('a lead of a DIFFERENT household cannot delete this contact (404, not 200 — and the contact survives)', async () => {
            as(leadB, { householdId: hhB });
            const res = await EC_DELETE(req('http://localhost/x', { method: 'DELETE' }), ecCtx(contact1));
            expect(res.status).not.toBe(200);
            expect(res.status).toBe(404);
            // The cross-household DELETE must not remove HH_A's contact.
            expect(await prisma.emergencyContact.findUnique({ where: { id: contact1 } })).not.toBeNull();
        });
        it('200 for the owning lead (PATCH)', async () => {
            as(leadA, { householdId: hhA });
            expect((await EC_PATCH(jsonReq({ name: 'Contact One Edited', phone: '555-555-1111' }), ecCtx(contact1))).status).toBe(200);
        });
        it('200 for the owning lead (DELETE, second valid contact present)', async () => {
            as(leadA, { householdId: hhA });
            expect((await EC_DELETE(req('http://localhost/x', { method: 'DELETE' }), ecCtx(contact2))).status).toBe(200);
        });
    });

    // ---- trusted-adults/[id]/withdraw (POST) — household-lead by id (IDOR) -----
    describe('POST /api/trusted-adults/[id]/withdraw', () => {
        it('401 unauthenticated', async () => {
            anon();
            expect((await TA_WITHDRAW(taReq(taWithdrawId, 'withdraw'))).status).toBe(401);
        });
        it('403 for a lead of a DIFFERENT household attacking by id (IDOR boundary) — and the review is untouched', async () => {
            as(leadB, { householdId: hhB });
            const auditBefore = await taAuditCount(taWithdrawId);
            expect((await TA_WITHDRAW(taReq(taWithdrawId, 'withdraw'))).status).toBe(403);
            expect(await latestReviewStatus(taWithdrawId)).toBe('PENDING_BOARD_REVIEW');
            expect(await taAuditCount(taWithdrawId)).toBe(auditBefore);
        });
        it('403 for a non-lead member of the owning household — and the review is untouched', async () => {
            as(memberA, { householdId: hhA });
            const auditBefore = await taAuditCount(taWithdrawId);
            expect((await TA_WITHDRAW(taReq(taWithdrawId, 'withdraw'))).status).toBe(403);
            expect(await latestReviewStatus(taWithdrawId)).toBe('PENDING_BOARD_REVIEW');
            expect(await taAuditCount(taWithdrawId)).toBe(auditBefore);
        });
        it('200 for a lead of the owning household', async () => {
            as(leadA, { householdId: hhA });
            expect((await TA_WITHDRAW(taReq(taWithdrawId, 'withdraw'))).status).toBe(200);
        });
    });

    // ---- trusted-adults/[id]/renew (POST) — household-lead by id (IDOR) --------
    describe('POST /api/trusted-adults/[id]/renew', () => {
        it('401 unauthenticated', async () => {
            anon();
            expect((await TA_RENEW(taReq(taRenewId, 'renew'))).status).toBe(401);
        });
        it('403 for a lead of a DIFFERENT household attacking by id (IDOR boundary) — and no review is opened', async () => {
            as(leadB, { householdId: hhB });
            const [reviewsBefore, auditBefore] = [await reviewCount(taRenewId), await taAuditCount(taRenewId)];
            expect((await TA_RENEW(taReq(taRenewId, 'renew'))).status).toBe(403);
            expect(await latestReviewStatus(taRenewId)).toBe('APPROVED');
            expect(await reviewCount(taRenewId)).toBe(reviewsBefore);
            expect(await taAuditCount(taRenewId)).toBe(auditBefore);
        });
        it('403 for a non-lead member of the owning household — and no review is opened', async () => {
            as(memberA, { householdId: hhA });
            const [reviewsBefore, auditBefore] = [await reviewCount(taRenewId), await taAuditCount(taRenewId)];
            expect((await TA_RENEW(taReq(taRenewId, 'renew'))).status).toBe(403);
            expect(await latestReviewStatus(taRenewId)).toBe('APPROVED');
            expect(await reviewCount(taRenewId)).toBe(reviewsBefore);
            expect(await taAuditCount(taRenewId)).toBe(auditBefore);
        });
        it('200 for a lead of the owning household', async () => {
            as(leadA, { householdId: hhA });
            expect((await TA_RENEW(taReq(taRenewId, 'renew'))).status).toBe(200);
        });
    });

    // ---- membership/payment (GET) — self-scoped (no id param), lead-only -------
    // No IDOR vector: the route derives the household from the session user, so a
    // caller can only ever reach their OWN household's process. Two boundaries:
    // the membership fee figure and the live checkout link are the lead's (a non-lead member
    // of the paying household gets 403), and a lead of another household must NOT
    // see this household's link.
    describe('GET /api/membership/payment', () => {
        it('401 unauthenticated', async () => {
            anon();
            expect((await PAYMENT_GET(req())).status).toBe(401);
        });
        it('403 for a non-lead member of the household awaiting payment', async () => {
            as(payMember, { householdId: hhPay });
            expect((await PAYMENT_GET(req())).status).toBe(403);
        });
        it('200 for the lead of the household awaiting payment', async () => {
            as(payLead, { householdId: hhPay });
            expect((await PAYMENT_GET(req())).status).toBe(200);
        });
        it('does not expose another household\'s payment process (409, not 200)', async () => {
            as(leadA, { householdId: hhA });
            expect((await PAYMENT_GET(req())).status).toBe(409);
        });
    });

    // ---- membership/renew (POST) — self-scoped --------------------------------
    describe('POST /api/membership/renew', () => {
        it('401 unauthenticated', async () => {
            anon();
            expect((await RENEW_POST(req('http://localhost/x', { method: 'POST' }))).status).toBe(401);
        });
        it('403 for a non-lead household member (renewal is the lead\'s call)', async () => {
            as(memberA, { householdId: hhA });
            expect((await RENEW_POST(req('http://localhost/x', { method: 'POST' }))).status).toBe(403);
        });
        it('409 for a lead with no renewal of their own (cannot reach another household\'s)', async () => {
            as(leadA, { householdId: hhA });
            expect((await RENEW_POST(req('http://localhost/x', { method: 'POST' }))).status).toBe(409);
        });
        it('200 for a lead of the household with an open renewal', async () => {
            as(renewUser, { householdId: hhRenew });
            expect((await RENEW_POST(req('http://localhost/x', { method: 'POST' }))).status).toBe(200);
        });
    });

    // ---- membership/renewal-status (GET) — self-scoped, lead-only soft-deny ----
    // Non-leads/non-owners get 200 { renewalDue: false } by design (it drives a
    // banner, not a privileged resource). The boundary: a non-owner never sees
    // another household's renewalDue: true.
    describe('GET /api/membership/renewal-status', () => {
        it('401 unauthenticated', async () => {
            anon();
            expect((await RENEWAL_STATUS_GET(req())).status).toBe(401);
        });
        it('renewalDue:false for a user whose household has no open renewal', async () => {
            as(memberA, { householdId: hhA });
            const json = await (await RENEWAL_STATUS_GET(req())).json();
            expect(json.renewalDue).toBe(false);
        });
        it('renewalDue:true for the lead of the household with an open renewal', async () => {
            as(renewalLead, { householdId: hhRenewal });
            const json = await (await RENEWAL_STATUS_GET(req())).json();
            expect(json.renewalDue).toBe(true);
        });
    });
});
