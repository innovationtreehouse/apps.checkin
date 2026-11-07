/**
 * @jest-environment node
 */
jest.mock('@/lib/auth', () => ({
    withAuth: (_opts: unknown, handler: (req: Request, auth: unknown) => unknown) =>
        (req: Request, auth: unknown) => handler(req, auth),
}));

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
});

describe('PUT /api/settings/email — alert, Board and finance contact addresses', () => {
    it.each(['alertEmailAddress', 'boardEmailAddress', 'financeContactEmail'])('saves a valid %s and records the edit', async (field) => {
        const res = await put({ [field]: ' finance@example.org ' });
        expect(res.status).toBe(200);
        expect(upsert.mock.calls[0][0].update).toEqual({ [field]: 'finance@example.org' });
        expect(audit).toHaveBeenCalledWith({
            data: expect.objectContaining({ actorId: 9, action: 'EDIT', tableName: 'BoardSettings', newData: { [field]: 'finance@example.org' } }),
        });
    });

    it.each([
        ['alertEmailAddress', 'not-an-email'],
        ['alertEmailAddress', 'a@example.org, b@example.org'],
        ['alertEmailAddress', 'Finance <finance@example.org>'],
        ['boardEmailAddress', 'board'],
        ['financeContactEmail', 'finance at example.org'],
    ])('refuses %s %p and writes nothing', async (field, value) => {
        const res = await put({ [field]: value });
        expect(res.status).toBe(400);
        expect(upsert).not.toHaveBeenCalled();
        expect(audit).not.toHaveBeenCalled();
    });

    it('clears a blank address to null', async () => {
        await put({ alertEmailAddress: '' });
        expect(upsert.mock.calls[0][0].update).toEqual({ alertEmailAddress: null });
    });
});
