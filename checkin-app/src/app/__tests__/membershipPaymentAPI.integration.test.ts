/**
 * @jest-environment node
 */
/**
 * Integration tests for the payment phase: dues, the Shopify checkout link
 * (with the volunteer discount code), the orders/paid webhook -> activate(),
 * and the board certify override.
 */

import crypto from 'crypto';
import { normalizeAuditData } from '@/lib/auditPayload';
import { POST as SHOPIFY_WEBHOOK } from '@/app/api/webhooks/shopify/route';
import { POST as CERTIFY } from '@/app/api/membership-ops/applications/certify-payment/route';
import { GET as PAYMENT } from '@/app/api/membership/payment/route';
import { ensurePaymentLink, ensurePaymentLinkForUser, activate } from '@/lib/membership/payment';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { sendEmail } from '@/lib/email';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/email', () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));

const TAG = 'payment-test';
const WEBHOOK_SECRET = 'shopify-test-secret';
const STORE_DOMAIN = 'shop.example';
const VARIANT_ID = '4567';
const DISCOUNT_CODE = 'VOLUNTEER';

function asBoard(id: number) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isSysadmin: false, isBoardMember: true } });
}
function asUser(id: number) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isSysadmin: false, isBoardMember: false } });
}
function shopifyReq(payload: unknown, secret: string) {
    const raw = JSON.stringify({ financial_status: 'paid', ...(payload as object) });
    const sig = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('base64');
    return new Request('http://localhost:4000/api/webhooks/shopify', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shopify-topic': 'orders/paid', 'x-shopify-hmac-sha256': sig },
        body: raw,
    });
}

describe('Membership payment API', () => {
    let leadId: number;
    let normalProc: number, normalMembership: number;
    let volProc: number;
    let certProc: number;
    let gateProc: number, gateLeadId: number, gateNonLeadId: number;
    const prevWebhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;
    const prevStoreDomain = process.env.SHOPIFY_STORE_DOMAIN;
    let prevSettings: { standardMembershipFeeCents: number; volunteerMembershipFeeCents: number; orgMembershipVariantId: string | null; volunteerDiscountCode: string | null } | null = null;

    async function makeProc(label: string, isVolunteer: boolean, withLead = false) {
        const hh = await prisma.household.create({ data: { name: `${label} ${TAG}` } });
        if (withLead) {
            const lead = await prisma.person.create({ data: { email: `lead-${TAG}@example.com`, name: 'Lead', householdId: hh.id } });
            await prisma.person.update({ where: { id: lead.id }, data: { isHouseholdLead: true } });
            leadId = lead.id;
        }
        const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE', isVolunteer } });
        // bgClearedAt set: the background check has already cleared, so paying
        // activates the membership (the BG-not-cleared path is covered by the
        // non-blocking flow test).
        const p = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.id, kind: 'INITIAL', status: 'PENDING_PAYMENT', bgClearedAt: new Date() } });
        return { householdId: hh.id, orgMembershipId: m.id, processId: p.id };
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

    beforeAll(async () => {
        process.env.SHOPIFY_WEBHOOK_SECRET = WEBHOOK_SECRET;
        process.env.SHOPIFY_STORE_DOMAIN = STORE_DOMAIN;
        const existing = await prisma.boardSettings.findUnique({ where: { id: 1 } });
        prevSettings = existing ? { standardMembershipFeeCents: existing.standardMembershipFeeCents, volunteerMembershipFeeCents: existing.volunteerMembershipFeeCents, orgMembershipVariantId: existing.orgMembershipVariantId, volunteerDiscountCode: existing.volunteerDiscountCode } : null;
        const settingsData = {
            standardMembershipFeeCents: 10000,
            volunteerMembershipFeeCents: 2500,
            orgMembershipVariantId: VARIANT_ID,
            volunteerDiscountCode: DISCOUNT_CODE,
        };
        await prisma.boardSettings.upsert({
            where: { id: 1 },
            create: { id: 1, ...settingsData },
            update: settingsData,
        });
        await wipe();

        const normal = await makeProc('Normal', false, true);
        normalProc = normal.processId;
        normalMembership = normal.orgMembershipId;
        volProc = (await makeProc('Vol', true)).processId;
        certProc = (await makeProc('Cert', false)).processId;

        // A household awaiting payment with both a lead and a non-lead member, for
        // the GET /api/membership/payment lead gate below.
        const gate = await makeProc('Gate', false);
        gateProc = gate.processId;
        const gLead = await prisma.person.create({ data: { email: `gate-lead-${TAG}@example.com`, name: 'Gate Lead', householdId: gate.householdId } });
        await prisma.person.update({ where: { id: gLead.id }, data: { isHouseholdLead: true } });
        gateLeadId = gLead.id;
        const gMember = await prisma.person.create({ data: { email: `gate-member-${TAG}@example.com`, name: 'Gate Member', householdId: gate.householdId } });
        gateNonLeadId = gMember.id;
    });

    afterAll(async () => {
        await wipe();
        if (prevSettings) await prisma.boardSettings.update({ where: { id: 1 }, data: prevSettings });
        if (prevWebhookSecret === undefined) delete process.env.SHOPIFY_WEBHOOK_SECRET;
        else process.env.SHOPIFY_WEBHOOK_SECRET = prevWebhookSecret;
        if (prevStoreDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
        else process.env.SHOPIFY_STORE_DOMAIN = prevStoreDomain;
        await prisma.$disconnect();
    });

    it('builds a checkout link to the membership product (no discount for normal)', async () => {
        const res = await ensurePaymentLink(normalProc);
        expect(res.amountCents).toBe(10000);
        expect(res.checkoutUrl).toBe(`https://${STORE_DOMAIN}/cart/${VARIANT_ID}:1?attributes[Membership_Process_ID]=${normalProc}`);
        expect(res.checkoutUrl).not.toContain('discount=');
    });

    it('uses the volunteer rate and appends the discount code for a volunteer household', async () => {
        const res = await ensurePaymentLink(volProc);
        expect(res.amountCents).toBe(2500);
        expect(res.checkoutUrl).toBe(`https://${STORE_DOMAIN}/cart/${VARIANT_ID}:1?discount=${DISCOUNT_CODE}&attributes[Membership_Process_ID]=${volProc}`);
    });

    it('resolves the payment link for the calling user', async () => {
        const res = await ensurePaymentLinkForUser(leadId);
        expect(res.amountCents).toBe(10000);
    });

    // ── GET /api/membership/payment: dues + checkout are lead-only ────────────
    const paymentReq = () => new Request('http://localhost:4000/api/membership/payment') as never;

    it('serves the dues amount and checkout link to a household lead', async () => {
        asUser(gateLeadId);
        const res = await PAYMENT(paymentReq());
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.amountCents).toBe(10000);
        expect(body.checkoutUrl).toContain(`attributes[Membership_Process_ID]=${gateProc}`);
    });

    it('refuses a non-lead household member (no dues, no checkout link)', async () => {
        asUser(gateNonLeadId);
        const res = await PAYMENT(paymentReq());
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error).toMatch(/household lead/);
        expect(body.amountCents).toBeUndefined();
        expect(body.checkoutUrl).toBeUndefined();
    });

    it('still serves a board member who is not a household lead', async () => {
        asBoard(gateNonLeadId);
        const res = await PAYMENT(paymentReq());
        expect(res.status).toBe(200);
        expect((await res.json()).amountCents).toBe(10000);
    });

    it('still serves a sysadmin who is not a household lead', async () => {
        await prisma.person.update({ where: { id: gateNonLeadId }, data: { isSysadmin: true } });
        try {
            asUser(gateNonLeadId);
            const res = await PAYMENT(paymentReq());
            expect(res.status).toBe(200);
            expect((await res.json()).amountCents).toBe(10000);
        } finally {
            await prisma.person.update({ where: { id: gateNonLeadId }, data: { isSysadmin: false } });
        }
    });

    it('orders/paid webhook activates the membership (and is idempotent)', async () => {
        // line_items must contain the configured orgMembershipVariantId or the H2 check rejects it (no membership item).
        const payload = { id: 555, line_items: [{ variant_id: VARIANT_ID }], note_attributes: [{ name: 'Membership_Process_ID', value: String(normalProc) }] };
        const res = await SHOPIFY_WEBHOOK(shopifyReq(payload, WEBHOOK_SECRET) as never);
        expect(res.status).toBe(200);

        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: normalProc } });
        expect(proc?.status).toBe('ACTIVE');
        expect(proc?.paidAt).not.toBeNull();
        expect(proc?.shopifyOrderId).toBe('555');
        const m = await prisma.orgMembership.findUnique({ where: { id: normalMembership } });
        expect(m?.status).toBe('ACTIVE');

        // Idempotent: a second identical webhook does not throw or change state.
        const again = await SHOPIFY_WEBHOOK(shopifyReq(payload, WEBHOOK_SECRET) as never);
        expect(again.status).toBe(200);
    });

    it('rejects a webhook with a bad HMAC', async () => {
        const res = await SHOPIFY_WEBHOOK(shopifyReq({ id: 1, note_attributes: [] }, 'wrong-secret') as never);
        expect(res.status).toBe(401);
    });

    it('board certify-payment activates without a Shopify payment', async () => {
        asBoard(leadId); // leadId is fine as an actor id; role mocked as board
        const res = await CERTIFY(new Request('http://localhost:4000/x', { method: 'POST', body: JSON.stringify({ processId: certProc, reason: 'Paid by check, deposited manually' }) }) as never);
        expect(res.status).toBe(200);
        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: certProc } });
        expect(proc?.status).toBe('ACTIVE');
        expect(proc?.manualPaymentById).toBe(leadId);
        expect(proc?.certificationNote).toBe('Paid by check, deposited manually');

        // The audit row records WHO recorded the payment — the acting board member, not SYSTEM_ACTOR.
        const audit = await prisma.auditLog.findFirst({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: certProc }, orderBy: { id: 'desc' } });
        expect(audit?.actorId).toBe(leadId);
        expect(normalizeAuditData(audit?.newData)).toMatchObject({ status: 'ACTIVE', certificationNote: 'Paid by check, deposited manually' });
    });

    it('certify without a reason is rejected (400), no state change', async () => {
        asBoard(leadId);
        const fresh = await makeProc('CertNoReason', false);
        const res = await CERTIFY(new Request('http://localhost:4000/x', { method: 'POST', body: JSON.stringify({ processId: fresh.processId }) }) as never);
        expect(res.status).toBe(400);

        const res2 = await CERTIFY(new Request('http://localhost:4000/x', { method: 'POST', body: JSON.stringify({ processId: fresh.processId, reason: '   ' }) }) as never);
        expect(res2.status).toBe(400);

        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: fresh.processId } });
        expect(proc?.status).toBe('PENDING_PAYMENT');
    });

    it('certify on a non-PENDING_PAYMENT process is rejected (409 wrong_phase, no state change)', async () => {
        asBoard(leadId);
        const bg = await makeProc('Bg', false);
        await prisma.orgMembershipProcess.update({ where: { id: bg.processId }, data: { status: 'PENDING_BG_REVIEW' } });

        const res = await CERTIFY(new Request('http://localhost:4000/x', { method: 'POST', body: JSON.stringify({ processId: bg.processId, reason: 'Board approved' }) }) as never);
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('wrong_phase');

        // No state change: status untouched and no activation audit row written.
        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: bg.processId } });
        expect(proc?.status).toBe('PENDING_BG_REVIEW');
        expect(proc?.paidAt).toBeNull();
        const audit = await prisma.auditLog.findFirst({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: bg.processId } });
        expect(audit).toBeNull();
    });

    it('certify on a non-existent process returns 404', async () => {
        asBoard(leadId);
        const res = await CERTIFY(new Request('http://localhost:4000/x', { method: 'POST', body: JSON.stringify({ processId: 999999999, reason: 'Board approved' }) }) as never);
        expect(res.status).toBe(404);
        expect((await res.json()).code).toBe('not_found');
    });

    it('non-board cannot certify', async () => {
        asUser(leadId);
        const res = await CERTIFY(new Request('http://localhost:4000/x', { method: 'POST', body: JSON.stringify({ processId: 1 }) }) as never);
        expect(res.status).toBe(403);
    });

    it('concurrent activate() of the same process sends one email and writes one audit row', async () => {
        // Fresh proc with a lead so a congrats email would fire.
        const hh = await prisma.household.create({ data: { name: `Concurrent ${TAG}` } });
        const lead = await prisma.person.create({ data: { email: `concurrent-${TAG}@example.com`, name: 'C Lead', householdId: hh.id } });
        await prisma.person.update({ where: { id: lead.id }, data: { isHouseholdLead: true } });
        const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE', isVolunteer: false } });
        // bgClearedAt set so paying activates (and the one congrats email fires).
        const p = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.id, kind: 'INITIAL', status: 'PENDING_PAYMENT', bgClearedAt: new Date() } });

        (sendEmail as jest.Mock).mockClear();

        // Two near-simultaneous deliveries (Shopify retry) hit the same sink.
        await Promise.all([
            activate(p.id, { via: 'payment', shopifyOrderId: 'race-1' }),
            activate(p.id, { via: 'payment', shopifyOrderId: 'race-2' }),
        ]);

        const auditRows = await prisma.auditLog.count({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: p.id } });
        expect(auditRows).toBe(1);
        expect(sendEmail as jest.Mock).toHaveBeenCalledTimes(1);

        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: p.id } });
        expect(proc?.status).toBe('ACTIVE');
    });

    it('activate() is a no-op once already ACTIVE', async () => {
        const before = await prisma.orgMembershipProcess.findUnique({ where: { id: normalProc } });
        await activate(normalProc, { via: 'payment', shopifyOrderId: 'ignored' });
        const after = await prisma.orgMembershipProcess.findUnique({ where: { id: normalProc } });
        expect(after?.shopifyOrderId).toBe(before?.shopifyOrderId); // unchanged
    });
});
