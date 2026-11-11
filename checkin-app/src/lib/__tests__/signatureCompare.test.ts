/**
 * @jest-environment node
 */
/**
 * Accept/refuse table for the shared compare and every caller routed through it:
 * a match, a wrong value, a different-length value and an empty value.
 */
import crypto from 'crypto';
import { logger } from '@/lib/logger';
import { requireCronSecret } from '@/lib/cronAuth';
import { verifyZohoToken } from '@/lib/membership/contract/zoho';
import { sign, verify } from '@/lib/outreach/unsubscribeToken';
import { constantTimeEqual, verifyShopifyHmac } from '../signatureCompare';

jest.mock('@/lib/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    logBackendError: jest.fn(),
}));

const SECRET = 'unit-secret-value';
const ENV_KEYS = ['CRON_SECRET', 'ZOHO_WEBHOOK_SECRET', 'SHOPIFY_WEBHOOK_SECRET', 'NEXTAUTH_SECRET', 'CHECKIN_ENV'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
    jest.clearAllMocks();
    process.env.CHECKIN_ENV = 'prod';
    process.env.CRON_SECRET = SECRET;
    process.env.ZOHO_WEBHOOK_SECRET = SECRET;
    process.env.SHOPIFY_WEBHOOK_SECRET = SECRET;
    process.env.NEXTAUTH_SECRET = SECRET;
});

afterAll(() => {
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
});

describe('constantTimeEqual', () => {
    it('accepts a matching value', () => {
        expect(constantTimeEqual('same-value', 'same-value')).toBe(true);
    });

    it('refuses a wrong value of the same length', () => {
        expect(constantTimeEqual('same-value', 'same-valuX')).toBe(false);
    });

    it('refuses a different-length value without throwing', () => {
        expect(constantTimeEqual('same-value', 'same-value-longer')).toBe(false);
    });

    it('refuses an empty value against a non-empty one', () => {
        expect(constantTimeEqual('same-value', '')).toBe(false);
        expect(constantTimeEqual('', 'same-value')).toBe(false);
    });

    it('treats two empty strings as equal, leaving unset secrets to the caller', () => {
        expect(constantTimeEqual('', '')).toBe(true);
    });

    it('compares UTF-8 text exactly', () => {
        expect(constantTimeEqual('café', 'café')).toBe(true);
        expect(constantTimeEqual('café', 'café')).toBe(false);
    });
});

describe('verifyShopifyHmac', () => {
    const BODY = '{"id":1,"note":"é"}';
    const goodSignature = (body = BODY) => crypto.createHmac('sha256', SECRET).update(body, 'utf8').digest('base64');
    const run = (signature?: string, body = BODY) => {
        const onRejected = jest.fn();
        const headers: Record<string, string> = signature === undefined ? {} : { 'x-shopify-hmac-sha256': signature };
        const req = new Request('http://localhost/api/webhooks/shopify', { method: 'POST', headers, body });
        return { result: verifyShopifyHmac(req, body, 'Test webhook', onRejected), onRejected };
    };

    it('accepts the signature of the exact bytes', () => {
        const { result, onRejected } = run(goodSignature());
        expect(result).toEqual({ ok: true });
        expect(onRejected).not.toHaveBeenCalled();
    });

    it('refuses a wrong signature of the same length', () => {
        const good = goodSignature();
        const { result, onRejected } = run((good[0] === 'A' ? 'B' : 'A') + good.slice(1));
        expect(result).toEqual({ ok: false, status: 401, error: 'Invalid signature' });
        expect(onRejected).toHaveBeenCalledWith('signature mismatch');
    });

    it('refuses a signature of a different length', () => {
        const { result, onRejected } = run(`${goodSignature()}A`);
        expect(result).toEqual({ ok: false, status: 401, error: 'Invalid signature' });
        expect(onRejected).toHaveBeenCalledWith('signature mismatch');
    });

    it('refuses a signature made over different bytes', () => {
        expect(run(goodSignature('{"id":2}')).result).toEqual({ ok: false, status: 401, error: 'Invalid signature' });
    });

    it.each([['absent', undefined], ['empty', '']])('refuses an %s signature as missing', (_label, signature) => {
        const { result, onRejected } = run(signature);
        expect(result).toEqual({ ok: false, status: 401, error: 'Missing signature' });
        expect(onRejected).toHaveBeenCalledWith('missing signature');
    });

    it('answers 500 when the secret is not configured, naming the source', () => {
        delete process.env.SHOPIFY_WEBHOOK_SECRET;
        const { result, onRejected } = run(goodSignature());
        expect(result).toEqual({ ok: false, status: 500, error: 'Configuration Error' });
        expect(onRejected).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith('Test webhook received but SHOPIFY_WEBHOOK_SECRET is not configured.');
    });
});

describe('requireCronSecret', () => {
    const status = (authorization?: string) => requireCronSecret(new Request('http://localhost/api/cron/x', {
        headers: authorization === undefined ? {} : { authorization },
    }))?.status ?? 200;

    it('accepts, and refuses wrong, different-length and empty values', () => {
        expect(status(`Bearer ${SECRET}`)).toBe(200);
        expect(status(`Bearer ${SECRET.replace('u', 'x')}`)).toBe(401);
        expect(status('Bearer short')).toBe(401);
        expect(status('')).toBe(401);
        expect(status('Bearer ')).toBe(401);
    });

    it('refuses everything when the secret is empty', () => {
        process.env.CRON_SECRET = '';
        expect(status('Bearer ')).toBe(401);
    });
});

describe('verifyZohoToken', () => {
    it('accepts, and refuses wrong, different-length and empty values', () => {
        expect(verifyZohoToken(SECRET)).toBe(true);
        expect(verifyZohoToken(SECRET.replace('u', 'x'))).toBe(false);
        expect(verifyZohoToken('short')).toBe(false);
        expect(verifyZohoToken('')).toBe(false);
        expect(verifyZohoToken(null)).toBe(false);
    });

    it('refuses everything when the secret is empty', () => {
        process.env.ZOHO_WEBHOOK_SECRET = '';
        expect(verifyZohoToken('')).toBe(false);
    });
});

describe('unsubscribe verify', () => {
    it('accepts, and refuses wrong, different-length and empty values', () => {
        const good = sign(7);
        expect(verify(7, good)).toBe(true);
        expect(verify(8, good)).toBe(false);
        expect(verify(7, `${good}A`)).toBe(false);
        expect(verify(7, '')).toBe(false);
        expect(verify(7, null)).toBe(false);
    });
});
