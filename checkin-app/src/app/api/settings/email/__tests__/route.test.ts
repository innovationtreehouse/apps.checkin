/**
 * @jest-environment node
 */
jest.mock('@/lib/auth', () => ({
    withAuth: (_opts: unknown, handler: (req: Request, auth: unknown) => unknown) =>
        (req: Request, auth: unknown) => handler(req, auth),
}));

// The shared prisma mock has no $transaction; this one runs the callback on itself.
jest.mock('@/lib/prisma', () => {
    const models: Record<string, unknown> = {};
    const client = new Proxy(models, { get: (target, prop: string) => (target[prop] ??= {}) });
    models.$transaction = (fn: (tx: unknown) => unknown) => fn(client);
    return { __esModule: true, default: client };
});

import { PUT } from '../route';
import prisma from '@/lib/prisma';

const AUTH = { type: 'session', user: { id: 9, isSysadmin: false, isBoardMember: true } };
const put = (body: unknown) =>
    (PUT as unknown as (req: Request, auth: unknown) => Promise<Response>)(
        new Request('http://localhost/api/settings/email', { method: 'PUT', body: JSON.stringify(body) }),
        AUTH,
    );

let upsert: jest.Mock;
let audit: jest.Mock;
beforeEach(() => {
    upsert = jest.fn().mockImplementation(({ update }) => Promise.resolve(update));
    audit = jest.fn().mockResolvedValue({});
    prisma.boardSettings.upsert = upsert;
    prisma.auditLog.create = audit;
    prisma.emailTemplate.findMany = jest.fn().mockResolvedValue([]);
});

const BARE_ADDRESS_FIELDS = ['boardEmailAddress', 'sysadminEmailAddress', 'bgReviewerEmailAddress', 'financeContactEmail'];

describe('PUT /api/settings/email — group and contact addresses', () => {
    it.each(BARE_ADDRESS_FIELDS)('saves a valid %s and records the edit', async (field) => {
        const res = await put({ [field]: ' list@example.org ' });
        expect(res.status).toBe(200);
        expect(upsert.mock.calls[0][0].update).toEqual({ [field]: 'list@example.org' });
        expect(audit).toHaveBeenCalledWith({
            data: expect.objectContaining({ actorId: 9, action: 'EDIT', tableName: 'BoardSettings', newData: { [field]: 'list@example.org' } }),
        });
    });

    it('saves the finance alert address to both its column and the alert column', async () => {
        const res = await put({ financeAlertEmailAddress: ' finance@example.org ' });
        expect(res.status).toBe(200);
        const written = { financeAlertEmailAddress: 'finance@example.org', alertEmailAddress: 'finance@example.org' };
        expect(upsert.mock.calls[0][0].update).toEqual(written);
        expect(upsert.mock.calls[0][0].create).toEqual({ id: 1, ...written });
        expect(audit).toHaveBeenCalledWith({ data: expect.objectContaining({ newData: written }) });
    });

    it('ignores a posted alertEmailAddress', async () => {
        await put({ alertEmailAddress: 'old@example.org' });
        expect(upsert.mock.calls[0][0].update).toEqual({});
    });

    it.each([
        ...['financeAlertEmailAddress', ...BARE_ADDRESS_FIELDS].flatMap((field) => [
            [field, 'not-an-email'],
            [field, 'a@example.org, b@example.org'],
            [field, 'List <list@example.org>'],
        ]),
    ])('refuses %s %p and writes nothing', async (field, value) => {
        const res = await put({ [field]: value });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(expect.objectContaining({ error: `${field} must be an email address` }));
        expect(upsert).not.toHaveBeenCalled();
        expect(audit).not.toHaveBeenCalled();
    });

    it.each(BARE_ADDRESS_FIELDS)('clears a blank %s to null', async (field) => {
        await put({ [field]: '' });
        expect(upsert.mock.calls[0][0].update).toEqual({ [field]: null });
    });

    it('clears a blank finance alert address in both columns', async () => {
        await put({ financeAlertEmailAddress: '' });
        expect(upsert.mock.calls[0][0].update).toEqual({ financeAlertEmailAddress: null, alertEmailAddress: null });
    });
});
