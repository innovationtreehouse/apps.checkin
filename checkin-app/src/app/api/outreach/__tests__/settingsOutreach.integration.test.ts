/**
 * @jest-environment node
 */
/**
 * Integration tests for GET/PUT /api/settings/outreach — the four template columns,
 * role gating (board/sysadmin/operations, NOT settings/email's narrower board/sysadmin),
 * and validate-on-save unknown-token rejection.
 */
import { GET, PUT } from '@/app/api/settings/outreach/route';
import prisma from '@/lib/prisma';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

function asRole(id: number, role: 'isBoardMember' | 'isSysadmin' | 'isOperations') {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, [role]: true } });
}
function asPlain(id: number) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id } });
}
function req(method: string, body?: unknown) {
    return new Request('http://localhost:4000/x', { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }) as never;
}

describe('GET/PUT /api/settings/outreach', () => {
    let restoreBoardSettings: () => Promise<void>;

    beforeAll(async () => {
        restoreBoardSettings = await snapshotBoardSettings();
    });

    afterAll(async () => {
        await restoreBoardSettings();
        await prisma.$disconnect();
    });

    it('rejects an unprivileged (non-board/sysadmin/operations) caller', async () => {
        asPlain(1);
        expect((await GET(req('GET'))).status).toBe(403);
        expect((await PUT(req('PUT', { outreachOpeningSubject: 'x' }))).status).toBe(403);
    });

    it('operations may read and write (unlike settings/email)', async () => {
        asRole(1, 'isOperations');
        expect((await GET(req('GET'))).status).toBe(200);
        const res = await PUT(req('PUT', { outreachOpeningSubject: 'Renew by {{deadline}}' }));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.settings.outreachOpeningSubject).toBe('Renew by {{deadline}}');
    });

    it('saves all four fields and round-trips them on GET', async () => {
        asRole(2, 'isBoardMember');
        const body = {
            outreachOpeningSubject: 'Time to {{actionWord}}',
            outreachOpeningBody: 'Hi {{name}}, {{actionLink}}',
            outreachReminderSubject: 'Reminder: {{actionWord}} by {{deadline}}',
            outreachReminderBody: 'Hi {{name}}, a friendly reminder.',
        };
        const putRes = await PUT(req('PUT', body));
        expect(putRes.status).toBe(200);

        const getRes = await GET(req('GET'));
        const data = await getRes.json();
        expect(data.settings).toEqual(expect.objectContaining(body));
    });

    it('rejects the WHOLE update with a 400 when any field carries an unknown token', async () => {
        asRole(3, 'isSysadmin');
        // Snapshot before, to prove the bad update didn't partially apply.
        const before = await (await GET(req('GET'))).json();

        const res = await PUT(req('PUT', {
            outreachOpeningSubject: 'Fine',
            outreachOpeningBody: 'Uses an unsupported {{unsubscribeUrl}} token',
        }));
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toMatch(/unsubscribeUrl/);

        const after = await (await GET(req('GET'))).json();
        expect(after.settings).toEqual(before.settings); // whole update rejected, nothing persisted
    });

    it('writes an audit log row on save', async () => {
        asRole(4, 'isBoardMember');
        const before = await prisma.auditLog.count({ where: { tableName: 'BoardSettings', action: 'EDIT' } });
        await PUT(req('PUT', { outreachReminderSubject: 'Audited change' }));
        const after = await prisma.auditLog.count({ where: { tableName: 'BoardSettings', action: 'EDIT' } });
        expect(after).toBe(before + 1);
    });
});
