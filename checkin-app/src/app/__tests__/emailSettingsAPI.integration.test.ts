/**
 * @jest-environment node
 */
/**
 * Integration tests for the email sender-identity settings API.
 */

import { GET as EMAIL_GET, PUT as EMAIL_PUT } from '@/app/api/settings/email/route';
import prisma from '@/lib/prisma';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

function asBoard(id: number) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isSysadmin: false, isBoardMember: true } });
}
function asUser(id: number) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isSysadmin: false, isBoardMember: false } });
}
function jsonReq(method: string, body?: unknown) {
    return new Request('http://localhost:4000/x', { method, ...(body ? { body: JSON.stringify(body) } : {}) }) as never;
}

const TAG = 'email-settings-test';

describe('Email sender-identity settings API', () => {
    let boardId: number, plainId: number;
    let restoreBoardSettings: () => Promise<void>;

    async function wipe() {
        const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const ids = hhs.map((h) => h.id);
        if (ids.length) {
            await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.household.deleteMany({ where: { id: { in: ids } } });
        }
    }

    beforeAll(async () => {
        await wipe();
        boardId = (await prisma.person.create({ data: { name: 'Board', isBoardMember: true, household: { create: { name: `Board HH ${TAG}` } } } })).id;
        plainId = (await prisma.person.create({ data: { name: 'Plain', household: { create: { name: `Plain HH ${TAG}` } } } })).id;
        restoreBoardSettings = await snapshotBoardSettings();
    });

    afterAll(async () => {
        await restoreBoardSettings();
        await wipe();
        await prisma.$disconnect();
    });

    it('non-board cannot read', async () => {
        asUser(plainId);
        expect((await EMAIL_GET(jsonReq('GET'))).status).toBe(403);
    });

    it('board reads, sets a valid identity (both header shapes), and reads it back', async () => {
        asBoard(boardId);
        expect((await EMAIL_GET(jsonReq('GET'))).status).toBe(200);

        const put = await EMAIL_PUT(jsonReq('PUT', {
            emailFromAddress: 'Treehouse <noreply@updates.example.org>',
            emailReplyToAddress: 'board@example.org',
        }));
        expect(put.status).toBe(200);
        const saved = (await put.json()).settings;
        expect(saved.emailFromAddress).toBe('Treehouse <noreply@updates.example.org>');
        expect(saved.emailReplyToAddress).toBe('board@example.org');
    });

    it('rejects a malformed From and keeps the previous value', async () => {
        asBoard(boardId);
        await EMAIL_PUT(jsonReq('PUT', { emailFromAddress: 'Good <ok@example.org>' }));
        const bad = await EMAIL_PUT(jsonReq('PUT', { emailFromAddress: 'not-an-email' }));
        expect(bad.status).toBe(400);
        const after = (await (await EMAIL_GET(jsonReq('GET'))).json()).settings;
        expect(after.emailFromAddress).toBe('Good <ok@example.org>');
    });

    it('accepts a comma-separated Reply-To list', async () => {
        asBoard(boardId);
        const put = await EMAIL_PUT(jsonReq('PUT', { emailReplyToAddress: 'info@example.org, ops@example.org' }));
        expect(put.status).toBe(200);
        const saved = (await put.json()).settings;
        expect(saved.emailReplyToAddress).toBe('info@example.org, ops@example.org');
    });

    it('rejects a Reply-To list with one malformed entry and keeps the previous value', async () => {
        asBoard(boardId);
        await EMAIL_PUT(jsonReq('PUT', { emailReplyToAddress: 'info@example.org, ops@example.org' }));
        const bad = await EMAIL_PUT(jsonReq('PUT', { emailReplyToAddress: 'info@example.org, not-an-email' }));
        expect(bad.status).toBe(400);
        const after = (await (await EMAIL_GET(jsonReq('GET'))).json()).settings;
        expect(after.emailReplyToAddress).toBe('info@example.org, ops@example.org');
    });

    it('empty strings clear back to null (env default From, no Reply-To)', async () => {
        asBoard(boardId);
        const cleared = await EMAIL_PUT(jsonReq('PUT', { emailFromAddress: '', emailReplyToAddress: '' }));
        expect(cleared.status).toBe(200);
        const s = (await cleared.json()).settings;
        expect(s.emailFromAddress).toBeNull();
        expect(s.emailReplyToAddress).toBeNull();
    });

    it('GET returns scholarshipNotifyEmail', async () => {
        asBoard(boardId);
        const res = await EMAIL_GET(jsonReq('GET'));
        expect(res.status).toBe(200);
        expect((await res.json()).settings).toHaveProperty('scholarshipNotifyEmail');
    });

    it('PUT round-trips a valid scholarshipNotifyEmail comma-list', async () => {
        asBoard(boardId);
        const put = await EMAIL_PUT(jsonReq('PUT', { scholarshipNotifyEmail: 'finance@example.org, board@example.org' }));
        expect(put.status).toBe(200);
        expect((await put.json()).settings.scholarshipNotifyEmail).toBe('finance@example.org, board@example.org');
    });

    it('rejects a malformed scholarshipNotifyEmail and keeps the previous value', async () => {
        asBoard(boardId);
        await EMAIL_PUT(jsonReq('PUT', { scholarshipNotifyEmail: 'finance@example.org' }));
        const bad = await EMAIL_PUT(jsonReq('PUT', { scholarshipNotifyEmail: 'not-an-email' }));
        expect(bad.status).toBe(400);
        const after = (await (await EMAIL_GET(jsonReq('GET'))).json()).settings;
        expect(after.scholarshipNotifyEmail).toBe('finance@example.org');
    });

    it('blank scholarshipNotifyEmail clears to null', async () => {
        asBoard(boardId);
        await EMAIL_PUT(jsonReq('PUT', { scholarshipNotifyEmail: 'finance@example.org' }));
        const cleared = await EMAIL_PUT(jsonReq('PUT', { scholarshipNotifyEmail: '' }));
        expect(cleared.status).toBe(200);
        expect((await cleared.json()).settings.scholarshipNotifyEmail).toBeNull();
    });

    it('PUT round-trips the scholarship ACK subject + both bodies', async () => {
        asBoard(boardId);
        const put = await EMAIL_PUT(jsonReq('PUT', {
            scholarshipAckSubject: 'Custom subject',
            scholarshipAckMembershipBody: 'Custom membership body.',
            scholarshipAckProgramBody: 'Custom program body for {{programName}}.',
        }));
        expect(put.status).toBe(200);
        const saved = (await put.json()).settings;
        expect(saved.scholarshipAckSubject).toBe('Custom subject');
        expect(saved.scholarshipAckMembershipBody).toBe('Custom membership body.');
        expect(saved.scholarshipAckProgramBody).toBe('Custom program body for {{programName}}.');

        const after = (await (await EMAIL_GET(jsonReq('GET'))).json()).settings;
        expect(after.scholarshipAckSubject).toBe('Custom subject');
        expect(after.scholarshipAckMembershipBody).toBe('Custom membership body.');
        expect(after.scholarshipAckProgramBody).toBe('Custom program body for {{programName}}.');
    });

    it('blank ACK fields clear back to null (default copy applies)', async () => {
        asBoard(boardId);
        await EMAIL_PUT(jsonReq('PUT', { scholarshipAckSubject: 'x', scholarshipAckMembershipBody: 'y', scholarshipAckProgramBody: 'z' }));
        const cleared = await EMAIL_PUT(jsonReq('PUT', { scholarshipAckSubject: '', scholarshipAckMembershipBody: '  ', scholarshipAckProgramBody: '' }));
        expect(cleared.status).toBe(200);
        const s = (await cleared.json()).settings;
        expect(s.scholarshipAckSubject).toBeNull();
        expect(s.scholarshipAckMembershipBody).toBeNull();
        expect(s.scholarshipAckProgramBody).toBeNull();
    });

    it('rejects an over-length ACK body and keeps the previous value', async () => {
        asBoard(boardId);
        await EMAIL_PUT(jsonReq('PUT', { scholarshipAckMembershipBody: 'Good body.' }));
        const tooLong = 'x'.repeat(5001);
        const bad = await EMAIL_PUT(jsonReq('PUT', { scholarshipAckMembershipBody: tooLong }));
        expect(bad.status).toBe(400);
        const after = (await (await EMAIL_GET(jsonReq('GET'))).json()).settings;
        expect(after.scholarshipAckMembershipBody).toBe('Good body.');
    });
});
