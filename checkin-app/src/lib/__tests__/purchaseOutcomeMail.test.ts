const mockSendEmail = jest.fn();
const mockFindFirst = jest.fn();
jest.mock('@/lib/email', () => ({ sendEmail: (...args: unknown[]) => mockSendEmail(...args) }));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        emailTemplate: { findUnique: async () => null },
        person: { findFirst: (...args: unknown[]) => mockFindFirst(...args) },
    },
}));
jest.mock('@/lib/config', () => ({ config: { baseUrl: () => 'https://app.example.org' } }));

import { REGISTRY } from '@/lib/email-templates/registry';
import { sendPurchaseOutcome, type PurchaseOutcome, type PurchaseOutcomeNotice } from '../purchaseOutcomeMail';

const UPLOADER = 7;
const REIMBURSEE = 9;
const PEOPLE: Record<number, { email: string | null; name: string; notificationSettings: unknown }> = {
    [UPLOADER]: { email: 'pat@example.org', name: 'Pat Uploader', notificationSettings: null },
    [REIMBURSEE]: { email: 'robin@example.org', name: 'Robin Reimbursed', notificationSettings: {} },
};

const notice = (over: Partial<PurchaseOutcomeNotice> = {}): PurchaseOutcomeNotice => ({
    receiptId: 'r-1',
    outcome: 'receipt_rejected',
    uploaderPersonId: UPLOADER,
    reimburseePersonId: REIMBURSEE,
    retailer: 'Hardware Depot',
    receiptDate: '2026-10-27',
    ...over,
});

beforeEach(() => {
    mockSendEmail.mockReset().mockResolvedValue(true);
    mockFindFirst.mockReset().mockImplementation(async ({ where }: { where: { id: number } }) => PEOPLE[where.id] ?? null);
});

const sentTo = () => mockSendEmail.mock.calls.map((c) => c[0]);
const html = () => mockSendEmail.mock.calls[0][2] as string;

describe('recipients', () => {
    it('sends the uploader and a different person reimbursed one copy each', async () => {
        expect(await sendPurchaseOutcome(notice(), 'uploader')).toBe(true);
        expect(await sendPurchaseOutcome(notice(), 'reimbursee')).toBe(true);
        expect(sentTo()).toEqual(['pat@example.org', 'robin@example.org']);
    });

    it('owes no reimbursee copy when the uploader is the person reimbursed', async () => {
        const mine = notice({ reimburseePersonId: UPLOADER });
        expect(await sendPurchaseOutcome(mine, 'uploader')).toBe(true);
        expect(await sendPurchaseOutcome(mine, 'reimbursee')).toBe(true);
        expect(sentTo()).toEqual(['pat@example.org']);
    });

    it('owes no reimbursee copy when nobody is reimbursed', async () => {
        expect(await sendPurchaseOutcome(notice({ reimburseePersonId: null }), 'reimbursee')).toBe(true);
        expect(mockFindFirst).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('looks up only a live, sign-in-verified person', async () => {
        await sendPurchaseOutcome(notice(), 'reimbursee');
        expect(mockFindFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: REIMBURSEE, accounts: { some: {} } },
        }));
    });

    it('treats a person with no verified address as done, without sending', async () => {
        mockFindFirst.mockResolvedValueOnce(null);
        expect(await sendPurchaseOutcome(notice(), 'reimbursee')).toBe(true);
        mockFindFirst.mockResolvedValueOnce({ ...PEOPLE[UPLOADER], email: null });
        expect(await sendPurchaseOutcome(notice(), 'uploader')).toBe(true);
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it.each([
        ['these emails', { emailPurchaseOutcomes: false }],
        ['all email', { email: false }],
    ])('treats a person who turned off %s as done, without sending', async (_what, settings) => {
        mockFindFirst.mockResolvedValueOnce({ ...PEOPLE[UPLOADER], notificationSettings: settings });
        expect(await sendPurchaseOutcome(notice(), 'uploader')).toBe(true);
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('asks for a retry when the send fails', async () => {
        mockSendEmail.mockResolvedValueOnce(false);
        expect(await sendPurchaseOutcome(notice(), 'uploader')).toBe(false);
    });

    it('asks for a retry, without sending, when the lookup fails', async () => {
        mockFindFirst.mockRejectedValueOnce(new Error('db down'));
        jest.spyOn(console, 'error').mockImplementationOnce(() => {});
        expect(await sendPurchaseOutcome(notice(), 'uploader')).toBe(false);
        expect(mockSendEmail).not.toHaveBeenCalled();
    });
});

describe('content', () => {
    const outcomes: [PurchaseOutcome, string][] = [
        ['receipt_rejected', 'Receipt not accepted'],
        ['expense_line_rejected', 'Receipt reviewed: a line was not approved'],
        ['reimbursement_complete', 'Reimbursement approved'],
    ];

    it.each(outcomes)('%s names only the recipient, the purchase and the link', async (outcome, subject) => {
        await sendPurchaseOutcome(notice({ outcome }), 'reimbursee');
        expect(mockSendEmail.mock.calls[0][1]).toBe(subject);
        expect(html()).toContain('Robin Reimbursed');
        expect(html()).toContain('a receipt for your reimbursement');
        expect(html()).toContain('Hardware Depot');
        expect(html()).toContain('October 27, 2026');
        expect(html()).toContain('href="https://app.example.org/receipts/r-1"');
        expect(html()).not.toContain('Pat Uploader');
    });

    it.each(outcomes)('%s to the uploader does not name the person reimbursed', async (outcome) => {
        await sendPurchaseOutcome(notice({ outcome }), 'uploader');
        expect(html()).toContain('your receipt');
        expect(html()).not.toContain('Robin Reimbursed');
    });

    it('shows a dash for a missing retailer or date and an unparsed date as stored', async () => {
        await sendPurchaseOutcome(notice({ retailer: null, receiptDate: null }), 'uploader');
        await sendPurchaseOutcome(notice({ receiptDate: '10/27/2026' }), 'uploader');
        expect(mockSendEmail.mock.calls[0][2]).toContain('Retailer: —');
        expect(mockSendEmail.mock.calls[0][2]).toContain('Date: —');
        expect(mockSendEmail.mock.calls[1][2]).toContain('Date: 10/27/2026');
    });

    it.each(['receipt.rejected', 'expense.lineRejected', 'expense.reimbursementComplete'] as const)(
        '%s takes no total, reason or other person\'s name',
        (key) => {
            expect(Object.keys(REGISTRY[key].allowedTokens).sort()).toEqual(['actionLink', 'date', 'name', 'receipt', 'retailer']);
        },
    );
});
