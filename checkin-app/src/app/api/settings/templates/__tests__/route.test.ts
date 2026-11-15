/**
 * @jest-environment node
 */
/**
 * Email Templates routes: list the saved rows, save one key after token
 * validation (a blank save removes the row), and send the editor's draft to the
 * caller. Sysadmins and the Board are admitted; operations is refused.
 */
import { getServerSession } from 'next-auth/next';
import prisma from '@/lib/prisma';
import { sendTemplateTest } from '@/lib/email-templates/send';
import { GET } from '../route';
import { PUT } from '../[key]/route';
import { POST } from '../[key]/test-send/route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/email-templates/send', () => ({ sendTemplateTest: jest.fn() }));

type Route = (req: Request, ctx: { params: Promise<{ key: string }> }) => Promise<Response>;
const call = (route: unknown, method: string, key: string, body?: unknown) =>
    (route as Route)(
        new Request(`http://localhost:4000/api/settings/templates/${key}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
        { params: Promise.resolve({ key }) },
    );
const as = (roles: Record<string, unknown>) =>
    jest.mocked(getServerSession).mockResolvedValue({ user: { id: 7, email: 'me@example.org', ...roles } });

const ROW = { key: 'enrollment.confirm', subject: 'Hi {{name}}', body: 'In {{programName}}.', updatedBy: 7, updatedAt: new Date('2026-11-14T12:00:00Z') };

let findMany: jest.Mock;
let upsert: jest.Mock;
let deleteMany: jest.Mock;
beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([ROW]);
    upsert = jest.fn().mockResolvedValue(ROW);
    deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    Object.assign(prisma.emailTemplate, { findMany, upsert, deleteMany });
    jest.mocked(sendTemplateTest).mockReset().mockResolvedValue(true);
});

describe('GET /api/settings/templates', () => {
    it.each([['a sysadmin', { isSysadmin: true }], ['the Board', { isBoardMember: true }]])('lists the saved rows for %s', async (_who, roles) => {
        as(roles);
        const res = await call(GET, 'GET', '');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ templates: [{ ...ROW, updatedAt: '2026-11-14T12:00:00.000Z' }] });
    });

    it.each([['operations', { isOperations: true }], ['finance', { isFinance: true }]])('refuses %s', async (_who, roles) => {
        as(roles);
        expect((await call(GET, 'GET', '')).status).toBe(403);
        expect(findMany).not.toHaveBeenCalled();
    });
});

describe('PUT /api/settings/templates/[key]', () => {
    it('saves the subject and body with the saver', async () => {
        as({ isBoardMember: true });
        const res = await call(PUT, 'PUT', 'enrollment.confirm', { subject: 'Hi {{name}}', body: 'In {{programName}}.' });
        expect(res.status).toBe(200);
        expect((await res.json()).template).toMatchObject({ key: 'enrollment.confirm', subject: 'Hi {{name}}' });
        const data = { subject: 'Hi {{name}}', body: 'In {{programName}}.', updatedBy: 7 };
        expect(upsert).toHaveBeenCalledWith({ where: { key: 'enrollment.confirm' }, create: { key: 'enrollment.confirm', ...data }, update: data });
    });

    it('removes the row on a blank save and answers null', async () => {
        as({ isSysadmin: true });
        const res = await call(PUT, 'PUT', 'enrollment.confirm', { subject: ' ', body: '' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ template: null });
        expect(deleteMany).toHaveBeenCalledWith({ where: { key: 'enrollment.confirm' } });
        expect(upsert).not.toHaveBeenCalled();
    });

    it('refuses a token the key does not allow, naming the field', async () => {
        as({ isBoardMember: true });
        const res = await call(PUT, 'PUT', 'enrollment.confirm', { subject: 'Hi', body: 'Pay at {{actionLink}}' });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/body uses \{\{actionLink\}\}/);
        expect(upsert).not.toHaveBeenCalled();
    });

    it.each([
        ['a missing body', { subject: 'Hi' }],
        ['a non-string subject', { subject: 3, body: 'x' }],
        ['an over-long body', { subject: 'Hi', body: 'x'.repeat(5001) }],
    ])('refuses %s', async (_what, body) => {
        as({ isBoardMember: true });
        expect((await call(PUT, 'PUT', 'enrollment.confirm', body)).status).toBe(400);
        expect(upsert).not.toHaveBeenCalled();
    });

    it('404s a key the registry does not have', async () => {
        as({ isBoardMember: true });
        expect((await call(PUT, 'PUT', 'no.such', { subject: 'a', body: 'b' })).status).toBe(404);
        expect((await call(PUT, 'PUT', 'constructor', { subject: 'a', body: 'b' })).status).toBe(404);
        expect(upsert).not.toHaveBeenCalled();
    });

    it('refuses operations', async () => {
        as({ isOperations: true });
        expect((await call(PUT, 'PUT', 'enrollment.confirm', { subject: 'a', body: 'b' })).status).toBe(403);
        expect(upsert).not.toHaveBeenCalled();
    });
});

describe('POST /api/settings/templates/[key]/test-send', () => {
    it('sends the draft to the caller and saves nothing', async () => {
        as({ isBoardMember: true });
        const res = await call(POST, 'POST', 'enrollment.confirm', { subject: 'Hi {{name}}', body: 'Draft' });
        expect(res.status).toBe(200);
        expect(sendTemplateTest).toHaveBeenCalledWith('enrollment.confirm', 'me@example.org', { subject: 'Hi {{name}}', body: 'Draft' });
        expect(upsert).not.toHaveBeenCalled();
    });

    it('refuses an unknown token without sending', async () => {
        as({ isSysadmin: true });
        expect((await call(POST, 'POST', 'enrollment.confirm', { subject: '{{oops}}', body: '' })).status).toBe(400);
        expect(sendTemplateTest).not.toHaveBeenCalled();
    });

    it('400s a caller with no email on file', async () => {
        as({ isBoardMember: true, email: null });
        expect((await call(POST, 'POST', 'enrollment.confirm', { subject: 'a', body: 'b' })).status).toBe(400);
        expect(sendTemplateTest).not.toHaveBeenCalled();
    });

    it('says so when the send fails', async () => {
        as({ isBoardMember: true });
        jest.mocked(sendTemplateTest).mockResolvedValue(false);
        expect((await call(POST, 'POST', 'enrollment.confirm', { subject: 'a', body: 'b' })).status).toBe(502);
    });

    it('refuses operations', async () => {
        as({ isOperations: true });
        expect((await call(POST, 'POST', 'enrollment.confirm', { subject: 'a', body: 'b' })).status).toBe(403);
        expect(sendTemplateTest).not.toHaveBeenCalled();
    });
});
