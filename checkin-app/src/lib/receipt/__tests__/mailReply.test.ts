const mockSendEmail = jest.fn();
jest.mock('@/lib/email', () => ({ sendEmail: (...args: unknown[]) => mockSendEmail(...args) }));
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: { emailTemplate: { findUnique: async () => null } } }));
jest.mock('@/lib/config', () => ({ config: { baseUrl: () => 'https://app.example.org' } }));

import type { MailAcknowledgement } from '@checkin/receipt';
import { sendMailReply } from '../mailReply';

const ack = (over: Partial<MailAcknowledgement> = {}): MailAcknowledgement => ({
    to: 'pat@example.org',
    mine: true,
    creditedName: 'Pat Smith',
    senderAddress: 'pat@example.org',
    receiptId: 'r-1',
    receivedAt: new Date('2026-10-27T12:00:00Z'),
    refused: [],
    ...over,
});

beforeEach(() => mockSendEmail.mockReset().mockResolvedValue(true));

const htmlFor = async (over: Partial<MailAcknowledgement> = {}): Promise<string> => {
    await sendMailReply(ack(over), undefined);
    return mockSendEmail.mock.calls[0][2];
};

describe('refused files', () => {
    const refused = [{ file: '<i>big</i>.pdf', reason: 'too_large' as const }];
    const alone = { receiptId: null, mine: false, creditedName: null, refused };

    it('says only what was refused and why when there is no receipt', async () => {
        const html = await htmlFor(alone);
        expect(html).toContain('&lt;i&gt;big&lt;/i&gt;.pdf');
        expect(html).toContain('10 MB');
        expect(html).not.toContain('/receipts/');
        expect(html).not.toContain('credited');
    });

    it('adds the refused files to an acknowledgement', async () => {
        const html = await htmlFor({ refused });
        expect(html).toContain('href="https://app.example.org/receipts/r-1"');
        expect(html).toContain('10 MB');
    });

    it('uses its own subject only when nothing was accepted', async () => {
        await sendMailReply(ack(alone), undefined);
        await sendMailReply(ack({ refused }), undefined);
        expect(mockSendEmail.mock.calls.map((c) => c[1])).toEqual(['Receipt not accepted', 'Receipt received']);
    });

    it('never treats a file name as a template token', async () => {
        expect(await htmlFor({ ...alone, refused: [{ file: '{{when}}.pdf', reason: 'empty' }] })).toContain('{{when}}.pdf');
    });
});

describe('the acknowledgement body', () => {
    it("tells the credited sender it is theirs, links it, and says how to say 'not me'", async () => {
        const html = await htmlFor();
        expect(html).toContain('a receipt you emailed on October 27, 2026');
        expect(html).toContain('href="https://app.example.org/receipts/r-1"');
        expect(html).toContain('Not yours? Discard it there');
    });

    it('names the sending address to a credited person who did not send it', async () => {
        expect(await htmlFor({ to: 'bob@example.org', senderAddress: 'helper@example.org' })).toContain('emailed from helper@example.org');
    });

    it('names nobody and links nothing on a sender copy for someone else', async () => {
        const html = await htmlFor({ to: 'helper@example.org', senderAddress: 'helper@example.org', mine: false, creditedName: null });
        expect(html).toContain('credited to a Treehouse member');
        expect(html).not.toContain('/receipts/');
        expect(html).toContain('If you did not send this email, reply');
    });

    it('escapes names and addresses', async () => {
        const html = await htmlFor({ creditedName: '<b>x</b>', to: 'bob@example.org', senderAddress: '"<i>"@example.org' });
        expect(html).not.toMatch(/<b>|<i>/);
    });
});

describe('sendMailReply', () => {
    it('sends as an automatic reply', async () => {
        await expect(sendMailReply(ack(), 'receipts@example.org')).resolves.toBe(true);
        expect(mockSendEmail).toHaveBeenCalledWith('pat@example.org', 'Receipt received', expect.any(String), { 'Auto-Submitted': 'auto-replied' });
    });

    it('reports a failed send', async () => {
        mockSendEmail.mockResolvedValue(false);
        await expect(sendMailReply(ack(), undefined)).resolves.toBe(false);
    });

    it('never mails the receipt mailbox itself', async () => {
        await expect(sendMailReply(ack({ to: 'Receipts@example.org' }), 'receipts@example.org')).resolves.toBe(true);
        expect(mockSendEmail).not.toHaveBeenCalled();
    });
});
