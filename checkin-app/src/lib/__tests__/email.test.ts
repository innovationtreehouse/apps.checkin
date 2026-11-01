let mockDevToolsActive = false;
const mockCapture = jest.fn();
const mockLogIntegrationError = jest.fn();
let mockIdentity: { from: string | null; replyTo?: string[] } = { from: 'test@test.com' };

jest.mock('resend');
jest.mock('../config.ts', () => ({
    config: {
        resendApiKey: () => null,
        emailFrom: () => 'test@test.com',
        devToolsActive: () => mockDevToolsActive,
    },
}));
jest.mock('../dev/sentMail', () => ({
    captureSentEmail: (...args: unknown[]) => mockCapture(...args),
}));
jest.mock('../emailIdentity', () => ({
    getEmailSenderIdentity: () => Promise.resolve(mockIdentity),
}));
jest.mock('../logger', () => ({
    logIntegrationError: (...args: unknown[]) => mockLogIntegrationError(...args),
}));

import { sendEmail } from '../email';
import { maskRecipient, runPaced } from '../email';

// process.env.NODE_ENV is typed read-only; tests need to vary it at runtime
const setNodeEnv = (value: string | undefined) => {
    Object.defineProperty(process.env, 'NODE_ENV', { value, configurable: true });
};

describe('maskRecipient', () => {
    it('keeps the first character and domain of each address', () => {
        expect(maskRecipient('jane@example.org')).toBe('j***@example.org');
        expect(maskRecipient('a@x.test, bob@y.test')).toBe('a***@x.test, b***@y.test');
        expect(maskRecipient('not-an-address')).toBe('***');
    });
});

describe('sendEmail no-key logging + capture', () => {
    let originalConsoleLog: (...data: unknown[]) => void;
    let originalEnv: string | undefined;

    beforeEach(() => {
        originalConsoleLog = console.log;
        console.log = jest.fn();
        originalEnv = process.env.NODE_ENV;
        mockDevToolsActive = false;
        mockCapture.mockReset();
        mockLogIntegrationError.mockReset();
        mockIdentity = { from: 'test@test.com' };
    });

    afterEach(() => {
        console.log = originalConsoleLog;
        setNodeEnv(originalEnv);
    });

    it('logs the To/Subject line but never the body (no body logging in any env)', async () => {
        setNodeEnv('development');
        mockDevToolsActive = true;
        mockCapture.mockResolvedValue(true);
        const html = 'Sensitive body <a href="reset">Link</a>';

        await sendEmail('test@test.com', 'Test Subject', html);

        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[Email (no RESEND_API_KEY)]'));
        expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining(html));
    });

    it('captures and returns true on a dev instance (gating callers get the happy-path)', async () => {
        setNodeEnv('development');
        mockDevToolsActive = true;
        mockCapture.mockResolvedValue(true);
        const html = '<p>Confirm <a href="/x">here</a></p>';

        const result = await sendEmail('to@test.com', 'Subj', html);

        expect(result).toBe(true);
        expect(mockCapture).toHaveBeenCalledWith('test@test.com', 'to@test.com', 'Subj', html);
    });

    it('returns false when the dev capture itself fails (does not mask a broken dev DB)', async () => {
        setNodeEnv('development');
        mockDevToolsActive = true;
        mockCapture.mockResolvedValue(false);

        const result = await sendEmail('to@test.com', 'Subj', '<p>hi</p>');

        expect(result).toBe(false);
    });

    it('captures on a dev instance even under a production BUILD (cloud-dev runs the prod image)', async () => {
        // A NODE_ENV fuse would make capture (and /dev/sent-mail) dead on cloud-dev,
        // whose container sets NODE_ENV=production exactly like prod's.
        setNodeEnv('production');
        mockDevToolsActive = true;
        mockCapture.mockResolvedValue(true);

        const result = await sendEmail('to@test.com', 'Subj', '<p>hi</p>');

        expect(result).toBe(true);
        expect(mockCapture).toHaveBeenCalled();
    });

    it('does NOT capture and returns false when not a dev instance', async () => {
        setNodeEnv('test');
        mockDevToolsActive = false;

        const result = await sendEmail('to@test.com', 'Subj', '<p>hi</p>');

        expect(result).toBe(false);
        expect(mockCapture).not.toHaveBeenCalled();
    });

    it('still captures on a dev instance when no From is configured either', async () => {
        // The no-key path runs first, so a dev box with neither an API key nor a
        // sender still captures.
        mockDevToolsActive = true;
        mockIdentity = { from: null };
        mockCapture.mockResolvedValue(true);

        const result = await sendEmail('to@test.com', 'Subj', '<p>hi</p>');

        expect(result).toBe(true);
        expect(mockCapture).toHaveBeenCalledWith('(no From configured)', 'to@test.com', 'Subj', '<p>hi</p>');
        expect(mockLogIntegrationError).not.toHaveBeenCalled();
    });
});

// The describe above mocks resendApiKey to null, so `resend` is null and only the
// no-key branch runs. These tests give email.ts a configured key (so `resend`
// is a real client) and exercise the two send-failure paths, which the suite above
// can't reach: Resend returning `{ error }`, and Resend throwing. Both must → false.
describe('sendEmail send-failure contract (Resend configured)', () => {
    const sendMock = jest.fn();
    let doMockIdentity: { from: string | null; replyTo?: string[] } = { from: 'test@test.com' };
    let doMockDevToolsActive = false;
    const logIntegrationErrorMock = jest.fn();
    let errorSpy: jest.SpyInstance;
    let logSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.resetModules();
        sendMock.mockReset();
        doMockIdentity = { from: 'test@test.com' };
        doMockDevToolsActive = false;
        logIntegrationErrorMock.mockReset();
        // Re-mock the module's deps for the fresh module instance loaded below.
        jest.doMock('../config.ts', () => ({
            config: {
                resendApiKey: () => 'test-key',
                emailFrom: () => 'test@test.com',
                isDevInstance: () => false,
                devToolsActive: () => doMockDevToolsActive,
            },
        }));
        jest.doMock('../dev/sentMail', () => ({ captureSentEmail: jest.fn() }));
        jest.doMock('../emailIdentity', () => ({ getEmailSenderIdentity: () => Promise.resolve(doMockIdentity) }));
        jest.doMock('resend', () => ({
            Resend: jest.fn().mockImplementation(() => ({ emails: { send: sendMock } })),
        }));
        // Mocked (not the real DB-writing logger) — this file is a unit test, no DB.
        jest.doMock('../logger', () => ({ logIntegrationError: logIntegrationErrorMock }));
        // Silence the expected error logging from the failure paths.
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        errorSpy.mockRestore();
        logSpy.mockRestore();
        jest.dontMock('../config.ts');
        jest.dontMock('../dev/sentMail');
        jest.dontMock('../emailIdentity');
        jest.dontMock('resend');
        jest.dontMock('../logger');
    });

    it('returns false when Resend responds with an { error }', async () => {
        sendMock.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'bad recipient' } });
        // Require AFTER doMock so the fresh module captures a non-null `resend`.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { sendEmail: send } = require('../email');

        const result = await send('test@test.com', 'Subject', '<p>hi</p>');
        expect(result).toBe(false);
        expect(sendMock).toHaveBeenCalledTimes(1);
    });

    it('returns false when the Resend call throws', async () => {
        sendMock.mockRejectedValue(new Error('network down'));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { sendEmail: send } = require('../email');

        const result = await send('test@test.com', 'Subject', '<p>hi</p>');
        expect(result).toBe(false);
        expect(sendMock).toHaveBeenCalledTimes(1);
    });

    it('passes the resolved From and, when set, a single Reply-To through to Resend', async () => {
        doMockIdentity = { from: 'Org <no-reply@org.test>', replyTo: ['board@org.test'] };
        sendMock.mockResolvedValue({ data: { id: '1' }, error: null });
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { sendEmail: send } = require('../email');

        const result = await send('to@org.test', 'Subject', '<p>hi</p>');
        expect(result).toBe(true);
        expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
            from: 'Org <no-reply@org.test>',
            replyTo: ['board@org.test'],
        }));
    });

    it('passes multiple Reply-To addresses through to Resend as an array, verbatim', async () => {
        doMockIdentity = { from: 'Org <no-reply@org.test>', replyTo: ['info@org.test', 'ops@org.test'] };
        sendMock.mockResolvedValue({ data: { id: '1' }, error: null });
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { sendEmail: send } = require('../email');

        const result = await send('to@org.test', 'Subject', '<p>hi</p>');
        expect(result).toBe(true);
        expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
            replyTo: ['info@org.test', 'ops@org.test'],
        }));
    });

    it('omits Reply-To and headers unless they are set', async () => {
        doMockIdentity = { from: 'test@test.com' };
        sendMock.mockResolvedValue({ data: { id: '1' }, error: null });
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { sendEmail: send } = require('../email');

        await send('to@test.com', 'Subject', '<p>hi</p>');
        expect(sendMock).toHaveBeenCalledTimes(1);
        expect(sendMock.mock.calls[0][0]).not.toHaveProperty('replyTo');
        expect(sendMock.mock.calls[0][0]).not.toHaveProperty('headers');

        await send('to@test.com', 'Subject', '<p>hi</p>', { 'Auto-Submitted': 'auto-replied' });
        expect(sendMock.mock.calls[1][0]).toMatchObject({ headers: { 'Auto-Submitted': 'auto-replied' } });
    });

    it('refuses to call Resend and returns false when neither source configures a From', async () => {
        doMockIdentity = { from: null };
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { sendEmail: send } = require('../email');

        const result = await send('to@org.test', 'Subject', '<p>hi</p>');

        expect(result).toBe(false);
        expect(sendMock).not.toHaveBeenCalled();
    });

    it('logs the missing sender as an integration error (to+subject, no body)', async () => {
        doMockIdentity = { from: null };
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { sendEmail: send } = require('../email');
        const html = 'Sensitive body <a href="reset">Link</a>';

        await send('to@org.test', 'Subject', html);

        expect(logIntegrationErrorMock).toHaveBeenCalledTimes(1);
        const [source, error, context] = logIntegrationErrorMock.mock.calls[0];
        expect(source).toBe('email');
        expect(String(error)).toContain('No From address configured');
        expect(context).toEqual({ to: 't***@org.test', subject: 'Subject' });
        expect(JSON.stringify(context)).not.toContain(html);
    });

    it('sends normally once a From is configured (the board override reaches Resend)', async () => {
        doMockIdentity = { from: 'Org <no-reply@org.test>' };
        sendMock.mockResolvedValue({ data: { id: '1' }, error: null });
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { sendEmail: send } = require('../email');

        const result = await send('to@org.test', 'Subject', '<p>hi</p>');

        expect(result).toBe(true);
        expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ from: 'Org <no-reply@org.test>' }));
        expect(logIntegrationErrorMock).not.toHaveBeenCalled();
    });

    it('persists an IntegrationErrorLog (to+subject, no body) when Resend responds with an { error }', async () => {
        sendMock.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'bad recipient' } });
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { sendEmail: send } = require('../email');
        const html = 'Sensitive body <a href="reset">Link</a>';

        await send('bounced@test.com', 'Subject', html);

        expect(logIntegrationErrorMock).toHaveBeenCalledTimes(1);
        const [source, error, context] = logIntegrationErrorMock.mock.calls[0];
        expect(source).toBe('email');
        expect(String(error)).toContain('bad recipient');
        expect(context).toEqual({ to: 'b***@test.com', subject: 'Subject' });
        expect(JSON.stringify(context)).not.toContain(html);
    });

    it('persists an IntegrationErrorLog when the Resend call throws', async () => {
        sendMock.mockRejectedValue(new Error('network down'));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { sendEmail: send } = require('../email');
        const html = '<p>Another sensitive body</p>';

        await send('bounced@test.com', 'Subject', html);

        expect(logIntegrationErrorMock).toHaveBeenCalledTimes(1);
        const [source, error, context] = logIntegrationErrorMock.mock.calls[0];
        expect(source).toBe('email');
        expect((error as Error).message).toBe('network down');
        expect(context).toEqual({ to: 'b***@test.com', subject: 'Subject' });
        expect(JSON.stringify(context)).not.toContain(html);
    });
});

describe('runPaced pacing', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('runs 12 thunks in chunks of 5/5/2 with 2 gaps, preserving order', async () => {
        const started: number[] = [];
        const tasks = Array.from({ length: 12 }, (_, i) => async () => {
            started.push(i);
            return i;
        });
        const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

        const resultsPromise = runPaced(tasks);

        // Before advancing any timers, only the first chunk (5) has run.
        await Promise.resolve();
        await Promise.resolve();
        expect(started).toEqual([0, 1, 2, 3, 4]);

        await jest.advanceTimersByTimeAsync(1000);
        expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

        await jest.advanceTimersByTimeAsync(1000);
        expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

        const results = await resultsPromise;
        expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

        // Exactly 2 gaps (between chunk 1→2 and chunk 2→3); no gap after the last chunk.
        expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);

        setTimeoutSpy.mockRestore();
    });
});
