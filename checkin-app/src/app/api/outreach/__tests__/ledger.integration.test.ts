/**
 * @jest-environment node
 */
/**
 * Integration tests for the client-driven chunked drain: create (snapshot + 409 guard),
 * process-batch (claim + send + no-double-send), resume, retry-failed, and test-send.
 * Audience semantics (member-only, the reminder's renewed-household skip, archived and
 * denied households) are covered in recipients.integration.test.ts — this file only needs
 * enough real recipients to drive the ledger's own lifecycle.
 */
import { POST as SEND } from '@/app/api/outreach/send/route';
import { POST as PROCESS_BATCH } from '@/app/api/outreach/process-batch/route';
import { GET as STATUS_GET, POST as STATUS_POST } from '@/app/api/outreach/status/route';
import { POST as TEST_SEND } from '@/app/api/outreach/test-send/route';
import prisma from '@/lib/prisma';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';
import { getServerSession } from 'next-auth/next';
import { sendEmail } from '@/lib/email';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn() }));
// config.nextAuthSecret() throws when unset, and CI has no .env. Same partial-mock pattern
// as auth-options-jwt.test.ts: keep every other config read (render.ts's baseUrl(), etc.)
// via requireActual and stub only the secret.
jest.mock('@/lib/config', () => {
    const actual = jest.requireActual('@/lib/config');
    return {
        __esModule: true,
        ...actual,
        config: {
            ...actual.config,
            nextAuthSecret: jest.fn(() => 'test-secret'),
        },
    };
});

const TAG = 'outreach-ledger-test';
const BOUNDARY = new Date(Date.UTC(2000, 7, 1)); // Aug 1

function asBoard(id: number, email = `board-${TAG}@example.com`) {
    (getServerSession as jest.Mock).mockResolvedValue({
        user: { id, email, isBoardMember: true, isSysadmin: false, isOperations: false },
    });
}
function asPlain(id: number) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isBoardMember: false, isSysadmin: false, isOperations: false } });
}

function req(method: string, body?: unknown) {
    return new Request('http://localhost:4000/x', { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }) as never;
}

async function setBoundary(date: Date | null) {
    await prisma.boardSettings.upsert({
        where: { id: 1 },
        create: { id: 1, standardMembershipFeeCents: 0, volunteerMembershipFeeCents: 0, orgMembershipYearBoundary: date },
        update: { orgMembershipYearBoundary: date },
    });
}

async function makeMemberLead(label: string, email: string) {
    const hh = await prisma.household.create({ data: { name: `${label} ${TAG}`, orgMembership: { create: { status: 'ACTIVE' } } } });
    await prisma.person.create({ data: { name: label, email, householdId: hh.id, isHouseholdLead: true } });
    return hh;
}

async function wipeHouseholds() {
    const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = hhs.map((h) => h.id);
    if (ids.length) {
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }
}

async function wipeLedger() {
    await prisma.bulkSendItem.deleteMany({});
    await prisma.bulkSend.deleteMany({});
}

describe('outreach ledger (send / process-batch / status)', () => {
    let restoreBoardSettings: () => Promise<void> = async () => {};
    let boardId: number;

    beforeAll(async () => {
        restoreBoardSettings = await snapshotBoardSettings();
    });

    afterAll(async () => {
        await wipeLedger();
        await wipeHouseholds();
        await restoreBoardSettings();
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        jest.clearAllMocks();
        (sendEmail as jest.Mock).mockResolvedValue(true);
        await wipeLedger();
        // The opening goes to every member-household lead — without re-wiping
        // households between tests, an earlier test's fixtures would still be in scope
        // for a later test's snapshot (and could blow past BATCH_SIZE, changing which
        // items land in the first batch). The board fixture is recreated below.
        await wipeHouseholds();
        const boardHh = await prisma.household.create({ data: { name: `Board ${TAG}` } });
        boardId = (await prisma.person.create({ data: { name: 'Board', email: `boardperson-${TAG}@example.com`, householdId: boardHh.id, isBoardMember: true } })).id;
        await setBoundary(BOUNDARY);
    });

    it('is forbidden for a plain (non-board/sysadmin/operations) user', async () => {
        asPlain(999999);
        const res = await SEND(req('POST', { emailType: 'opening' }));
        expect(res.status).toBe(403);
    });

    it('blocks create-send with a clear error when the boundary is unset', async () => {
        await setBoundary(null);
        asBoard(boardId);
        const res = await SEND(req('POST', { emailType: 'opening' }));
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toMatch(/boundary/i);
    });

    it('create -> batch -> complete: drains every queued item and sets completedAt', async () => {
        await makeMemberLead('Lifecycle1', `lifecycle1-${TAG}@example.com`);
        await makeMemberLead('Lifecycle2', `lifecycle2-${TAG}@example.com`);
        asBoard(boardId);

        const createRes = await SEND(req('POST', { emailType: 'opening' }));
        expect(createRes.status).toBe(201);
        const created = await createRes.json();
        expect(created.counts.queued).toBeGreaterThanOrEqual(2);
        const bulkSendId = created.bulkSend.id;

        let remaining = created.counts.queued;
        let guard = 0;
        while (remaining > 0 && guard++ < 10) {
            const res = await PROCESS_BATCH(req('POST', { bulkSendId }));
            expect(res.status).toBe(200);
            const data = await res.json();
            remaining = data.remaining;
        }
        expect(remaining).toBe(0);

        const bulkSend = await prisma.bulkSend.findUniqueOrThrow({ where: { id: bulkSendId } });
        expect(bulkSend.completedAt).not.toBeNull();
        const items = await prisma.bulkSendItem.findMany({ where: { bulkSendId } });
        expect(items.every((i) => i.status === 'sent')).toBe(true);
        expect(sendEmail).toHaveBeenCalledTimes(items.length);
    });

    it('409s a concurrent create while one send is already in flight', async () => {
        await makeMemberLead('Conflict1', `conflict1-${TAG}@example.com`);
        asBoard(boardId);

        const first = await SEND(req('POST', { emailType: 'opening' }));
        expect(first.status).toBe(201);

        const second = await SEND(req('POST', { emailType: 'reminder' }));
        expect(second.status).toBe(409);
    });

    it('resume: a partially-drained send (more recipients than one batch) stays in-flight, and a second process-batch call (what Resume does) finishes it', async () => {
        // BATCH_SIZE is 40 — 45 recipients guarantees the first call claims only 40,
        // leaving the send genuinely in-flight (simulating a closed tab mid-drain)
        // without needing to fake anything about the route itself.
        const RECIPIENT_COUNT = 45;
        for (let i = 0; i < RECIPIENT_COUNT; i++) {
            await makeMemberLead(`Resume${i}`, `resume${i}-${TAG}@example.com`);
        }
        asBoard(boardId);

        const createRes = await SEND(req('POST', { emailType: 'opening' }));
        const created = await createRes.json();
        expect(created.counts.queued).toBeGreaterThanOrEqual(RECIPIENT_COUNT);
        const bulkSendId = created.bulkSend.id;

        const first = await PROCESS_BATCH(req('POST', { bulkSendId }));
        const firstData = await first.json();
        expect(firstData.processed).toBe(40);
        expect(firstData.remaining).toBeGreaterThan(0); // genuinely still in-flight

        const statusRes = await STATUS_GET(req('GET'));
        const status = await statusRes.json();
        expect(status.inFlight).not.toBeNull();
        expect(status.inFlight.id).toBe(bulkSendId);
        expect(status.inFlight.counts.sent).toBe(40);
        expect(status.inFlight.counts.queued).toBe(firstData.remaining);

        // Reopening the panel and hitting process-batch again — no special "resume"
        // endpoint, just the same call the drain loop always makes — finishes it.
        let remaining = firstData.remaining;
        let guard = 0;
        while (remaining > 0 && guard++ < 5) {
            const res = await PROCESS_BATCH(req('POST', { bulkSendId }));
            remaining = (await res.json()).remaining;
        }
        expect(remaining).toBe(0);

        const finalStatus = await (await STATUS_GET(req('GET'))).json();
        expect(finalStatus.inFlight).toBeNull();
        expect(finalStatus.lastCompleted.id).toBe(bulkSendId);
        expect(finalStatus.lastCompleted.counts.sent).toBeGreaterThanOrEqual(RECIPIENT_COUNT);
    });

    it('retry-failed re-queues failed items and lets the drain finish them', async () => {
        await makeMemberLead('Failing', `failing-${TAG}@example.com`);
        await makeMemberLead('Passing', `passing-${TAG}@example.com`);
        asBoard(boardId);

        (sendEmail as jest.Mock).mockImplementation(async (to: string) => !to.startsWith('failing-'));

        const createRes = await SEND(req('POST', { emailType: 'opening' }));
        const created = await createRes.json();
        const bulkSendId = created.bulkSend.id;

        await PROCESS_BATCH(req('POST', { bulkSendId }));
        const midway = await prisma.bulkSendItem.findMany({ where: { bulkSendId } });
        expect(midway.some((i) => i.status === 'failed')).toBe(true);
        const completedAfterFirstDrain = await prisma.bulkSend.findUniqueOrThrow({ where: { id: bulkSendId } });
        expect(completedAfterFirstDrain.completedAt).not.toBeNull(); // 0 queued remain (1 sent, 1 failed)

        (sendEmail as jest.Mock).mockResolvedValue(true); // "fix" the problem before retrying
        const retryRes = await STATUS_POST(req('POST', { action: 'retry', bulkSendId }));
        expect(retryRes.status).toBe(200);
        const retryData = await retryRes.json();
        expect(retryData.bulkSend.completedAt).toBeNull(); // reopened

        await PROCESS_BATCH(req('POST', { bulkSendId }));
        const final = await prisma.bulkSendItem.findMany({ where: { bulkSendId } });
        expect(final.every((i) => i.status === 'sent')).toBe(true);
        const finalBulkSend = await prisma.bulkSend.findUniqueOrThrow({ where: { id: bulkSendId } });
        expect(finalBulkSend.completedAt).not.toBeNull();
    });

    it('retry 409s when another send is already in flight (protects the one-in-flight invariant)', async () => {
        await makeMemberLead('RetryGuard', `retryguard-${TAG}@example.com`);
        asBoard(boardId);

        // Send A: force a failure so it completes with a failed item (0 queued → completedAt set).
        (sendEmail as jest.Mock).mockResolvedValue(false);
        const aRes = await SEND(req('POST', { emailType: 'opening' }));
        const a = await aRes.json();
        await PROCESS_BATCH(req('POST', { bulkSendId: a.bulkSend.id }));
        expect((await prisma.bulkSend.findUniqueOrThrow({ where: { id: a.bulkSend.id } })).completedAt).not.toBeNull();

        // Send B: created after A completed, left un-drained so it is genuinely in flight.
        (sendEmail as jest.Mock).mockResolvedValue(true);
        const bRes = await SEND(req('POST', { emailType: 'reminder' }));
        expect(bRes.status).toBe(201);

        // Retrying A would reopen a second in-flight row — reject it, and don't re-queue A's failures.
        const retry = await STATUS_POST(req('POST', { action: 'retry', bulkSendId: a.bulkSend.id }));
        expect(retry.status).toBe(409);
        expect((await prisma.bulkSend.findUniqueOrThrow({ where: { id: a.bulkSend.id } })).completedAt).not.toBeNull();
        expect(await prisma.bulkSendItem.count({ where: { bulkSendId: a.bulkSend.id, status: 'failed' } })).toBe(1);
    });

    it('no double-send: two concurrent process-batch calls on the same send never send an item twice', async () => {
        for (let i = 0; i < 8; i++) {
            await makeMemberLead(`Race${i}`, `race${i}-${TAG}@example.com`);
        }
        asBoard(boardId);

        const createRes = await SEND(req('POST', { emailType: 'opening' }));
        const created = await createRes.json();
        const bulkSendId = created.bulkSend.id;
        const totalQueued = created.counts.queued;

        const [a, b] = await Promise.all([
            PROCESS_BATCH(req('POST', { bulkSendId })),
            PROCESS_BATCH(req('POST', { bulkSendId })),
        ]);
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        const [aData, bData] = await Promise.all([a.json(), b.json()]);

        // Every queued item was claimed by exactly one of the two overlapping calls —
        // never both (the guarded per-item claim), and never neither (nothing left queued).
        expect(aData.processed + bData.processed).toBe(totalQueued);
        expect(sendEmail).toHaveBeenCalledTimes(totalQueued);
        const remaining = await prisma.bulkSendItem.count({ where: { bulkSendId, status: 'queued' } });
        expect(remaining).toBe(0);

        // A further re-POST (the "already-processed batch" case) claims and sends nothing.
        const third = await PROCESS_BATCH(req('POST', { bulkSendId }));
        expect(third.status).toBe(404); // already completedAt-set — nothing left to drain
    });

    it('a renewal email reaches a member whose invitation email is suppressed, with no unsubscribe footer', async () => {
        const hh = await makeMemberLead('Suppressed', `suppressed-${TAG}@example.com`);
        const person = await prisma.person.findFirstOrThrow({ where: { householdId: hh.id } });
        await prisma.person.update({ where: { id: person.id }, data: { emailSuppressed: true } });
        await prisma.boardSettings.update({ where: { id: 1 }, data: { outreachOpeningSubject: 'Time to {{actionWord}}', outreachOpeningBody: 'Hi {{name}}' } });
        asBoard(boardId);

        const created = await (await SEND(req('POST', { emailType: 'opening' }))).json();
        const bulkSendId = created.bulkSend.id;
        const item = await prisma.bulkSendItem.findFirstOrThrow({ where: { bulkSendId, personId: person.id } });
        expect(item).toMatchObject({ status: 'queued', variant: 'renew' });

        let remaining = created.counts.queued;
        let guard = 0;
        while (remaining > 0 && guard++ < 5) {
            remaining = (await (await PROCESS_BATCH(req('POST', { bulkSendId }))).json()).remaining;
        }

        expect((await prisma.bulkSendItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe('sent');
        const call = (sendEmail as jest.Mock).mock.calls.find(([to]) => to === `suppressed-${TAG}@example.com`);
        expect(call?.[1]).toBe('Time to renew');
        expect(call?.[2]).not.toContain('Unsubscribe');
    });

    it('a DENIED household lead is left out of the snapshot entirely', async () => {
        const hh = await makeMemberLead('Denied', `denied-${TAG}@example.com`);
        await prisma.orgMembership.update({ where: { householdId: hh.id }, data: { status: 'DENIED' } });
        const person = await prisma.person.findFirstOrThrow({ where: { householdId: hh.id } });
        asBoard(boardId);

        const created = await (await SEND(req('POST', { emailType: 'opening' }))).json();
        expect(await prisma.bulkSendItem.count({ where: { bulkSendId: created.bulkSend.id, personId: person.id } })).toBe(0);
    });

    it('drain skips a household DENIED after the snapshot: no email, item marked skipped_denied', async () => {
        const hh = await makeMemberLead('LateDeny', `latedeny-${TAG}@example.com`);
        const person = await prisma.person.findFirstOrThrow({ where: { householdId: hh.id } });
        asBoard(boardId);

        const created = await (await SEND(req('POST', { emailType: 'opening' }))).json();
        const bulkSendId = created.bulkSend.id;
        const item = await prisma.bulkSendItem.findFirstOrThrow({ where: { bulkSendId, personId: person.id } });
        expect(item.status).toBe('queued');

        await prisma.orgMembership.update({ where: { householdId: hh.id }, data: { status: 'DENIED' } });

        let remaining = created.counts.queued;
        let guard = 0;
        while (remaining > 0 && guard++ < 5) {
            remaining = (await (await PROCESS_BATCH(req('POST', { bulkSendId }))).json()).remaining;
        }

        expect((await prisma.bulkSendItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe('skipped_denied');
        expect((sendEmail as jest.Mock).mock.calls.some(([to]) => to === `latedeny-${TAG}@example.com`)).toBe(false);
    });

    it('drain skips a household that stops being a member after the snapshot, and a legacy join item to a non-member', async () => {
        const revoked = await makeMemberLead('LateRevoke', `laterevoke-${TAG}@example.com`);
        const revokedPerson = await prisma.person.findFirstOrThrow({ where: { householdId: revoked.id } });
        asBoard(boardId);

        const created = await (await SEND(req('POST', { emailType: 'opening' }))).json();
        const bulkSendId = created.bulkSend.id;
        const item = await prisma.bulkSendItem.findFirstOrThrow({ where: { bulkSendId, personId: revokedPerson.id } });
        await prisma.orgMembership.update({ where: { householdId: revoked.id }, data: { status: 'REVOKED' } });

        // A join item left by a send queued before this rule, for a household with no membership.
        const legacyHh = await prisma.household.create({ data: { name: `LegacyJoin ${TAG}` } });
        const legacyPerson = await prisma.person.create({ data: { name: 'Legacy', email: `legacyjoin-${TAG}@example.com`, householdId: legacyHh.id, isHouseholdLead: true } });
        const legacyItem = await prisma.bulkSendItem.create({
            data: { bulkSendId, personId: legacyPerson.id, email: `legacyjoin-${TAG}@example.com`, variant: 'join', status: 'queued' },
        });

        let remaining = created.counts.queued + 1;
        let guard = 0;
        while (remaining > 0 && guard++ < 5) {
            remaining = (await (await PROCESS_BATCH(req('POST', { bulkSendId }))).json()).remaining;
        }

        expect((await prisma.bulkSendItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe('skipped_not_member');
        expect((await prisma.bulkSendItem.findUniqueOrThrow({ where: { id: legacyItem.id } })).status).toBe('skipped_not_member');
        const sentTo = (sendEmail as jest.Mock).mock.calls.map(([to]) => to);
        expect(sentTo).not.toContain(`laterevoke-${TAG}@example.com`);
        expect(sentTo).not.toContain(`legacyjoin-${TAG}@example.com`);
    });

    it('drain skips a legacy join item for a lead who opted out of invitations, even in an ACTIVE household', async () => {
        const hh = await makeMemberLead('LegacySuppressed', `legacysuppressed-${TAG}@example.com`);
        const person = await prisma.person.findFirstOrThrow({ where: { householdId: hh.id } });
        await prisma.person.update({ where: { id: person.id }, data: { emailSuppressed: true } });
        const bulkSend = await prisma.bulkSend.create({
            data: {
                emailType: 'opening', audience: 'a', senderId: boardId,
                items: { create: { personId: person.id, email: `legacysuppressed-${TAG}@example.com`, variant: 'join', status: 'queued' } },
            },
            include: { items: true },
        });
        asBoard(boardId);

        await PROCESS_BATCH(req('POST', { bulkSendId: bulkSend.id }));

        expect((await prisma.bulkSendItem.findUniqueOrThrow({ where: { id: bulkSend.items[0].id } })).status).toBe('skipped_unsubscribed');
        expect((sendEmail as jest.Mock).mock.calls.some(([to]) => to === `legacysuppressed-${TAG}@example.com`)).toBe(false);
    });

    it('test-send renders the renew copy once and sends it to the caller', async () => {
        asBoard(boardId, `tester-${TAG}@example.com`);
        const res = await TEST_SEND(req('POST', {
            subject: 'Renew by {{deadline}}',
            body: 'Hi {{name}}, please {{actionWord}} at {{actionLink}}.',
        }));
        expect(res.status).toBe(200);
        expect(sendEmail).toHaveBeenCalledTimes(1);
        const [to, subject, html] = (sendEmail as jest.Mock).mock.calls[0];
        expect(to).toBe(`tester-${TAG}@example.com`);
        expect(subject).toMatch(/^\[Test\] Renew by /);
        expect(html).toContain('please renew');
        expect(html).not.toContain('Unsubscribe');
    });
});
