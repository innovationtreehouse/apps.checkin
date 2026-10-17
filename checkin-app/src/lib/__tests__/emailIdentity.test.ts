const mockFindUnique = jest.fn();
let mockEnvFrom: string | null = 'env-default@example.com';
jest.mock('../prisma', () => ({ __esModule: true, default: { boardSettings: { findUnique: (...a: unknown[]) => mockFindUnique(...a) } } }));
jest.mock('../config', () => ({ config: { emailFrom: () => mockEnvFrom } }));

import { getEmailSenderIdentity } from '../emailIdentity';

describe('getEmailSenderIdentity', () => {
    beforeEach(() => {
        mockFindUnique.mockReset();
        mockEnvFrom = 'env-default@example.com';
    });

    it('falls back to the env From with no Reply-To when nothing is configured', async () => {
        mockFindUnique.mockResolvedValue(null);
        expect(await getEmailSenderIdentity()).toEqual({ from: 'env-default@example.com', replyTo: undefined });
    });

    it('lets BoardSettings override the From and set a single Reply-To (one-element array)', async () => {
        mockFindUnique.mockResolvedValue({ emailFromAddress: 'Org <no-reply@org.test>', emailReplyToAddress: 'board@org.test' });
        expect(await getEmailSenderIdentity()).toEqual({ from: 'Org <no-reply@org.test>', replyTo: ['board@org.test'] });
    });

    it('parses a comma-separated Reply-To into an array', async () => {
        mockFindUnique.mockResolvedValue({ emailFromAddress: null, emailReplyToAddress: 'info@org.test, ops@org.test' });
        expect(await getEmailSenderIdentity()).toEqual({ from: 'env-default@example.com', replyTo: ['info@org.test', 'ops@org.test'] });
    });

    it('trims whitespace and dedupes Reply-To entries', async () => {
        mockFindUnique.mockResolvedValue({ emailFromAddress: null, emailReplyToAddress: '  info@org.test ,info@org.test,  ops@org.test' });
        expect(await getEmailSenderIdentity()).toEqual({ from: 'env-default@example.com', replyTo: ['info@org.test', 'ops@org.test'] });
    });

    it('treats blank/whitespace values as unset (env From, no Reply-To)', async () => {
        mockFindUnique.mockResolvedValue({ emailFromAddress: '   ', emailReplyToAddress: '' });
        expect(await getEmailSenderIdentity()).toEqual({ from: 'env-default@example.com', replyTo: undefined });
    });

    it('never blocks mail: falls back to the env From if the settings read throws', async () => {
        mockFindUnique.mockRejectedValue(new Error('db down'));
        expect(await getEmailSenderIdentity()).toEqual({ from: 'env-default@example.com' });
    });

    it('reports a null From when neither the board nor the env configures a sender', async () => {
        mockEnvFrom = null;
        mockFindUnique.mockResolvedValue({ emailFromAddress: null, emailReplyToAddress: null });
        expect(await getEmailSenderIdentity()).toEqual({ from: null, replyTo: undefined });
    });

    it('uses the board From when the env has none', async () => {
        mockEnvFrom = null;
        mockFindUnique.mockResolvedValue({ emailFromAddress: 'Org <no-reply@org.test>', emailReplyToAddress: null });
        expect(await getEmailSenderIdentity()).toEqual({ from: 'Org <no-reply@org.test>', replyTo: undefined });
    });
});
