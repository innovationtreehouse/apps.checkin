/**
 * @jest-environment node
 */
/**
 * A refunded order never activates a membership; the app stops and raises it to
 * the Board. Covers both activation paths: a late orders/paid after the refund
 * (payment-first) and a second approval after the refund (check-last).
 */

import { attest, boardResetReview } from '@/lib/membership/review';
import { activateByProcessId } from '@/lib/membership/payment';
import { raiseReversalByOrderId } from '@/lib/finance/reconcile/reversals';
import { isOrderReversed } from '@/lib/finance/reconcile/exceptions';
import { raiseMembershipPaymentOutcome } from '@/lib/finance/reconcile/membership';
import { resetTokenCache } from '@/lib/shopify/client';
import prisma from '@/lib/prisma';
import { sendEmail } from '@/lib/email';

jest.mock('@/lib/email', () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));

const TAG = 'refund-gate-test';
const orderId = (label: string) => `${TAG}-${label}-${Math.random().toString(36).slice(2)}`;

async function makePerson(label: string, extra: { isBackgroundCheckReviewer?: boolean; isBoardMember?: boolean }) {
    const p = await prisma.person.create({
        data: { email: `${label}-${TAG}@example.com`, name: label, ...extra, household: { create: { name: `${label} HH ${TAG}` } } },
    });
    return p.id;
}

/** A household with one lead, a NONE membership and an INITIAL process in the given state. */
async function makeApplicant(data: { status: 'PENDING_PAYMENT' | 'PENDING_BG_CLEARANCE' | 'PENDING_BG_REVIEW' | 'BLOCKED'; paid?: boolean; bgCleared?: boolean; shopifyOrderId?: string }) {
    const hh = await prisma.household.create({ data: { name: `Applicant ${TAG} ${Math.random()}` } });
    const lead = await prisma.person.create({ data: { email: `lead-${Math.random()}-${TAG}@example.com`, name: 'Lead', householdId: hh.id } });
    await prisma.person.update({ where: { id: lead.id }, data: { isHouseholdLead: true } });
    const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
    const now = new Date();
    const proc = await prisma.orgMembershipProcess.create({
        data: {
            orgMembershipId: m.id,
            kind: 'INITIAL',
            status: data.status,
            contractSignedAt: now,
            bgConsentAt: now,
            bgClearedAt: data.bgCleared ? now : null,
            paidAt: data.paid ? now : null,
            shopifyOrderId: data.shopifyOrderId ?? null,
        },
    });
    return { processId: proc.id, orgMembershipId: m.id, leadId: lead.id };
}

const processOf = (id: number) => prisma.orgMembershipProcess.findUnique({ where: { id } });
const membershipStatusOf = async (id: number) => (await prisma.orgMembership.findUnique({ where: { id } }))?.status;
const emailed = (text: string) =>
    (sendEmail as jest.Mock).mock.calls.some((args: unknown[]) => args.some((a) => typeof a === 'string' && a.includes(text)));

async function wipe() {
    await prisma.paymentException.deleteMany({ where: { shopifyOrderId: { startsWith: `${TAG}-` } } });
    await prisma.auditLog.deleteMany({ where: { tableName: 'ShopifyOrderReversal', newData: { path: ['shopifyOrderId'], string_starts_with: `${TAG}-` } } });
    const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = hhs.map((h) => h.id);
    if (ids.length) {
        await prisma.backgroundCheckAttestation.deleteMany({ where: { process: { orgMembership: { householdId: { in: ids } } } } });
        await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: ids } } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }
}

describe('a refunded order never activates', () => {
    let revA: number, revB: number, board: number;

    beforeAll(async () => {
        await wipe();
        revA = await makePerson('RevA', { isBackgroundCheckReviewer: true });
        revB = await makePerson('RevB', { isBackgroundCheckReviewer: true });
        board = await makePerson('Board', { isBoardMember: true });
    });
    beforeEach(() => (sendEmail as jest.Mock).mockClear());
    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    it('path A: a refund before orders/paid is kept, and the late orders/paid is raised, not applied', async () => {
        const oid = orderId('A');
        const { processId, orgMembershipId } = await makeApplicant({ status: 'PENDING_PAYMENT', bgCleared: true });

        // The refund matches no application yet.
        expect(await raiseReversalByOrderId(oid, 'REFUND', [], `${oid}-r1`)).toBe(false);

        // A retried orders/paid carries the original paid payload.
        const { outcome } = await activateByProcessId(processId, oid, { appliesToYear: 2026 });
        await raiseMembershipPaymentOutcome(outcome, { shopifyOrderId: oid, processId });

        expect(outcome).toBe('refunded');
        const proc = await processOf(processId);
        expect(proc?.status).toBe('PENDING_PAYMENT');
        expect(proc?.paidAt).toBeNull();
        expect(await membershipStatusOf(orgMembershipId)).toBe('NONE');
        const ex = await prisma.paymentException.findFirst({ where: { kind: 'REVERSED_BEFORE_ACTIVATION', processId } });
        expect(ex?.severity).toBe('CRITICAL');
        expect(emailed('Payment problem (REVERSED_BEFORE_ACTIVATION)')).toBe(true);
    });

    it('path B: a refund on a paid application waiting on its check is CRITICAL, and the second approval does not activate', async () => {
        const oid = orderId('B');
        const { processId, orgMembershipId, leadId } = await makeApplicant({ status: 'PENDING_BG_CLEARANCE', paid: true, shopifyOrderId: oid });

        expect(await raiseReversalByOrderId(oid, 'REFUND', [], `${oid}-r1`)).toBe(true);
        const refund = await prisma.paymentException.findFirst({ where: { kind: 'REFUND', processId } });
        expect(refund?.severity).toBe('CRITICAL');
        expect(emailed('Payment problem (REFUND)')).toBe(true);

        await attest(revA, processId, { result: 'APPROVE', subjectPersonIds: [leadId] });
        await attest(revB, processId, { result: 'APPROVE', subjectPersonIds: [leadId] });

        const proc = await processOf(processId);
        expect(proc?.status).toBe('PENDING_BG_CLEARANCE');
        expect(proc?.bgClearedAt).toBeTruthy();
        expect(await membershipStatusOf(orgMembershipId)).toBe('NONE');
        expect(await prisma.paymentException.count({ where: { kind: 'REVERSED_BEFORE_ACTIVATION', processId } })).toBe(1);
    });

    describe('a refund Shopify has made and not reported', () => {
        const realFetch = global.fetch;
        const shopifyAnswers = (order: () => Response) => {
            resetTokenCache();
            global.fetch = jest.fn(async (url: string | URL | Request) =>
                String(url).includes('access_token') ? new Response(JSON.stringify({ access_token: 't' })) : order(),
            ) as typeof fetch;
        };
        const refundedOrder = () => new Response(JSON.stringify({
            data: { order: { displayFinancialStatus: 'REFUNDED', cancelledAt: null, totalRefundedSet: { shopMoney: { amount: '50.00' } } } },
        }));

        beforeAll(() => {
            process.env.SHOPIFY_STORE_DOMAIN = 'store.example.com';
            process.env.SHOPIFY_CLIENT_ID = 'id';
            process.env.SHOPIFY_CLIENT_SECRET = 'secret';
        });
        afterAll(() => {
            delete process.env.SHOPIFY_STORE_DOMAIN;
            delete process.env.SHOPIFY_CLIENT_ID;
            delete process.env.SHOPIFY_CLIENT_SECRET;
        });
        afterEach(() => {
            global.fetch = realFetch;
        });

        it('orders/paid is refused and raised', async () => {
            const oid = orderId('unreported-paid');
            const { processId, orgMembershipId } = await makeApplicant({ status: 'PENDING_PAYMENT', bgCleared: true });
            shopifyAnswers(refundedOrder);

            const { outcome } = await activateByProcessId(processId, oid, { appliesToYear: 2026 });

            expect(outcome).toBe('refunded');
            expect((await processOf(processId))?.paidAt).toBeNull();
            expect(await membershipStatusOf(orgMembershipId)).toBe('NONE');
        });

        it('the second approval on a paid application holds it instead of activating', async () => {
            const oid = orderId('unreported-clear');
            const { processId, orgMembershipId, leadId } = await makeApplicant({ status: 'PENDING_BG_CLEARANCE', paid: true, shopifyOrderId: oid });
            shopifyAnswers(refundedOrder);

            await attest(revA, processId, { result: 'APPROVE', subjectPersonIds: [leadId] });
            await attest(revB, processId, { result: 'APPROVE', subjectPersonIds: [leadId] });

            expect((await processOf(processId))?.status).toBe('PENDING_BG_CLEARANCE');
            expect(await membershipStatusOf(orgMembershipId)).toBe('NONE');
        });

        it('when Shopify cannot answer, a payment throws and an approval says to retry, and neither changes anything', async () => {
            const oid = orderId('outage');
            const unpaid = await makeApplicant({ status: 'PENDING_PAYMENT', bgCleared: true });
            const paid = await makeApplicant({ status: 'PENDING_BG_CLEARANCE', paid: true, shopifyOrderId: oid });
            shopifyAnswers(() => new Response('down', { status: 503 }));
            const logged = jest.spyOn(console, 'error').mockImplementation();

            await expect(activateByProcessId(unpaid.processId, oid, { appliesToYear: 2026 })).rejects.toThrow();
            await expect(attest(revA, paid.processId, { result: 'APPROVE', subjectPersonIds: [paid.leadId] })).rejects.toMatchObject({
                code: 'shopify_unavailable',
                message: expect.stringContaining('try again later'),
            });
            expect(logged).toHaveBeenCalled();
            logged.mockRestore();

            expect((await processOf(unpaid.processId))?.status).toBe('PENDING_PAYMENT');
            expect(await prisma.backgroundCheckAttestation.count({ where: { processId: paid.processId } })).toBe(0);
        });
    });

    it('path B: the Board resolving the refund flag before clearance still does not activate', async () => {
        const oid = orderId('Bres');
        const { processId, orgMembershipId, leadId } = await makeApplicant({ status: 'PENDING_BG_CLEARANCE', paid: true, shopifyOrderId: oid });

        await raiseReversalByOrderId(oid, 'REFUND', [], `${oid}-r1`);
        await prisma.paymentException.updateMany({
            where: { kind: 'REFUND', processId },
            data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedById: board, resolutionNote: 'noted' },
        });
        (sendEmail as jest.Mock).mockClear();

        await attest(revA, processId, { result: 'APPROVE', subjectPersonIds: [leadId] });
        await attest(revB, processId, { result: 'APPROVE', subjectPersonIds: [leadId] });

        expect((await processOf(processId))?.status).toBe('PENDING_BG_CLEARANCE');
        expect(await membershipStatusOf(orgMembershipId)).toBe('NONE');
        expect(await prisma.paymentException.count({ where: { kind: 'REVERSED_BEFORE_ACTIVATION', processId, severity: 'CRITICAL' } })).toBe(1);
        // Neither the welcome nor the payment-open notice goes to the family.
        expect(emailed('Welcome to the Treehouse')).toBe(false);
        expect(emailed('you can now pay your membership dues')).toBe(false);
    });

    it('a paid, blocked, refunded application whose rejector changes to approve holds at the second approval instead of activating', async () => {
        const oid = orderId('Blk');
        const { processId, orgMembershipId, leadId } = await makeApplicant({ status: 'PENDING_BG_CLEARANCE', paid: true, shopifyOrderId: oid });
        await attest(revA, processId, { result: 'REJECT', note: 'concern' });

        await raiseReversalByOrderId(oid, 'REFUND', [], `${oid}-r1`);
        await prisma.paymentException.updateMany({ where: { kind: 'REFUND', processId }, data: { status: 'RESOLVED', resolvedAt: new Date() } });

        await attest(revA, processId, { result: 'APPROVE', subjectPersonIds: [leadId] });
        expect((await processOf(processId))?.status).toBe('PENDING_BG_CLEARANCE');
        await attest(revB, processId, { result: 'APPROVE', subjectPersonIds: [leadId] });

        expect((await processOf(processId))?.status).toBe('PENDING_BG_CLEARANCE');
        expect(await membershipStatusOf(orgMembershipId)).toBe('NONE');
        expect(await prisma.paymentException.count({ where: { kind: 'REVERSED_BEFORE_ACTIVATION', processId, severity: 'CRITICAL' } })).toBe(1);
    });

    it('a legacy paid PENDING_BG_REVIEW application on a refunded order is held at clearance, not activated', async () => {
        const oid = orderId('Rev');
        const { processId, orgMembershipId, leadId } = await makeApplicant({ status: 'PENDING_BG_REVIEW', paid: true, shopifyOrderId: oid });

        expect(await raiseReversalByOrderId(oid, 'REFUND', [], `${oid}-r1`)).toBe(true);
        expect((await prisma.paymentException.findFirst({ where: { kind: 'REFUND', processId } }))?.severity).toBe('CRITICAL');

        await attest(revA, processId, { result: 'APPROVE', subjectPersonIds: [leadId] });
        await attest(revB, processId, { result: 'APPROVE', subjectPersonIds: [leadId] });

        const proc = await processOf(processId);
        expect(proc?.status).toBe('PENDING_BG_CLEARANCE');
        expect(proc?.bgClearedAt).toBeTruthy();
        expect(await membershipStatusOf(orgMembershipId)).toBe('NONE');
        expect(await prisma.paymentException.count({ where: { kind: 'REVERSED_BEFORE_ACTIVATION', processId, severity: 'CRITICAL' } })).toBe(1);
        expect(emailed('Welcome to the Treehouse')).toBe(false);
    });

    it('a refund arriving while a payment holds the order waits for it, then finds the application', async () => {
        const oid = orderId('race');
        const { processId } = await makeApplicant({ status: 'PENDING_PAYMENT' });
        let release!: () => void;
        const released = new Promise<void>((r) => (release = r));
        let lockHeld!: () => void;
        const locked = new Promise<void>((r) => (lockHeld = r));
        // The payment's settle(): reads the order unreversed, then records it on the application.
        const payment = prisma.$transaction(async (tx) => {
            expect(await isOrderReversed(tx, oid)).toBe(false);
            lockHeld();
            await released;
            await tx.orgMembershipProcess.update({ where: { id: processId }, data: { status: 'PENDING_BG_CLEARANCE', paidAt: new Date(), shopifyOrderId: oid } });
        }, { timeout: 20_000 });
        await locked;

        let finished = false;
        const refund = raiseReversalByOrderId(oid, 'REFUND', [], `${oid}-r1`).then((matched) => { finished = true; return matched; });
        await new Promise((r) => setTimeout(r, 1_000));
        expect(finished).toBe(false);
        release();
        await payment;

        expect(await refund).toBe(true);
        expect((await prisma.paymentException.findFirst({ where: { kind: 'REFUND', processId } }))?.severity).toBe('CRITICAL');
    });

    it('an unrefunded order still activates, on either path', async () => {
        const payFirst = await makeApplicant({ status: 'PENDING_PAYMENT', bgCleared: true });
        const { outcome } = await activateByProcessId(payFirst.processId, orderId('C1'), { appliesToYear: 2026 });
        expect(outcome).toBe('active');
        expect(await membershipStatusOf(payFirst.orgMembershipId)).toBe('ACTIVE');

        const checkLast = await makeApplicant({ status: 'PENDING_BG_CLEARANCE', paid: true, shopifyOrderId: orderId('C2') });
        await attest(revA, checkLast.processId, { result: 'APPROVE', subjectPersonIds: [checkLast.leadId] });
        await attest(revB, checkLast.processId, { result: 'APPROVE', subjectPersonIds: [checkLast.leadId] });
        expect((await processOf(checkLast.processId))?.status).toBe('ACTIVE');
        expect(await membershipStatusOf(checkLast.orgMembershipId)).toBe('ACTIVE');
    });

    it('a payment on a blocked application keeps its year through a board reset and clearance', async () => {
        const { processId, orgMembershipId, leadId } = await makeApplicant({ status: 'BLOCKED' });

        expect((await activateByProcessId(processId, orderId('BlkYear'), { appliesToYear: 2026 })).outcome).toBe('paid_while_blocked');
        expect((await boardResetReview(processId, board)).status).toBe('PENDING_BG_CLEARANCE');
        await attest(revA, processId, { result: 'APPROVE', subjectPersonIds: [leadId] });
        await attest(revB, processId, { result: 'APPROVE', subjectPersonIds: [leadId] });

        const proc = await processOf(processId);
        expect(proc?.status).toBe('ACTIVE');
        expect(proc?.appliesToYear).toBe(2026);
        expect(await membershipStatusOf(orgMembershipId)).toBe('ACTIVE');
    });
});
