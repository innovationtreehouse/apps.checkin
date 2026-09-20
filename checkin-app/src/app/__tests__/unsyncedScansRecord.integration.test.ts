/**
 * @jest-environment node
 */
/**
 * Record-visit resolution against the real DB (docs/rules/attendance-checkin.md,
 * kiosk resilience): a parked RawBadgeLog row resolves into a Visit written at
 * the row's OWN timestamp — the manual tool's staleness bound deliberately
 * does not apply — with the open-IN outcome chosen by the reviewer. The
 * facility-closed 403 branch lives in the unit file: it reads a global
 * predicate (any open keyholder visit) a sibling suite can flip mid-run.
 */
import { POST } from '@/app/api/system-status/unsynced-scans/[id]/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/auth-options', () => ({ authOptions: {} }));

const TAG = 'unsynced-record-test';
const mockSession = getServerSession as jest.Mock;

const req = (id: number, body?: Record<string, unknown>) =>
    new Request(`http://localhost/api/system-status/unsynced-scans/${id}`, {
        method: 'POST',
        ...(body ? { body: JSON.stringify(body) } : {}),
    }) as unknown as import('next/server').NextRequest;
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

describe('unsynced-scans record resolution (real DB)', () => {
    let keyholderId: number;
    let memberId: number;
    const householdIds: number[] = [];
    let keyholderVisitId: number;

    beforeAll(async () => {
        const keyholder = await prisma.person.create({
            data: { name: 'Record Key', email: `key-${TAG}@example.com`, isKeyholder: true, household: { create: { name: 'Test HH' } } },
        });
        keyholderId = keyholder.id;
        householdIds.push(keyholder.householdId);
        const member = await prisma.person.create({
            data: { name: 'Record Member', email: `member-${TAG}@example.com`, household: { create: { name: 'Test HH' } } },
        });
        memberId = member.id;
        householdIds.push(member.householdId);

        // Our own open keyholder visit makes leave-open deterministic: the
        // global count is ≥1 no matter what sibling suites are doing.
        const kv = await prisma.visit.create({
            data: { personId: keyholderId, arrivedAt: new Date(0), arrivedVia: 'SCANNER' },
        });
        keyholderVisitId = kv.id;

        mockSession.mockResolvedValue({ user: { id: keyholderId, isKeyholder: true } });
    });

    afterEach(async () => {
        await prisma.visit.deleteMany({ where: { personId: memberId } });
        await prisma.presenceEvent.deleteMany({ where: { personId: memberId } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: memberId } });
    });

    afterAll(async () => {
        await prisma.visit.deleteMany({ where: { id: keyholderVisitId } });
        await prisma.person.deleteMany({ where: { id: { in: [keyholderId, memberId] } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    });

    function park(overrides: Record<string, unknown> = {}) {
        return prisma.rawBadgeLog.create({
            data: {
                personId: memberId,
                timestamp: new Date('2026-08-20T19:14:00.000Z'), // days late by design
                reviewReason: 'stale_replay',
                ...overrides,
            },
        });
    }

    it('records a days-old scan as a closed visit at scannedAt (staleness bound does not apply)', async () => {
        const row = await park();
        const res = await POST(req(row.id, { action: 'record', departedAt: '2026-08-20T21:00:00.000Z' }), ctx(row.id));
        expect(res.status).toBe(200);

        const visit = await prisma.visit.findFirst({ where: { personId: memberId } });
        expect(visit?.arrivedAt).toEqual(new Date('2026-08-20T19:14:00.000Z'));
        expect(visit?.departedAt).toEqual(new Date('2026-08-20T21:00:00.000Z'));
        expect(visit?.arrivedVia).toBe('SCANNER');

        const stamped = await prisma.rawBadgeLog.findUnique({ where: { id: row.id } });
        expect(stamped?.reviewedAt).not.toBeNull();
        expect(stamped?.reviewedBy).toBe(keyholderId);
        expect(stamped?.reviewReason).toBe('stale_replay'); // still says why it parked
    });

    it('leave-open mints an open visit while a keyholder is present', async () => {
        const row = await park({ timestamp: new Date() });
        const res = await POST(req(row.id, { action: 'record' }), ctx(row.id));
        expect(res.status).toBe(200);

        const visit = await prisma.visit.findFirst({ where: { personId: memberId } });
        expect(visit?.departedAt).toBeNull();
    });

    it('409s when a visit already covers the scan time, leaving the row unreviewed', async () => {
        const row = await park();
        await prisma.visit.create({
            data: {
                personId: memberId,
                arrivedAt: new Date('2026-08-20T19:00:00.000Z'),
                departedAt: new Date('2026-08-20T20:00:00.000Z'),
                arrivedVia: 'SCANNER',
            },
        });
        const res = await POST(req(row.id, { action: 'record', departedAt: '2026-08-20T21:00:00.000Z' }), ctx(row.id));
        expect(res.status).toBe(409);

        expect((await prisma.rawBadgeLog.findUnique({ where: { id: row.id } }))?.reviewedAt).toBeNull();
        expect(await prisma.visit.count({ where: { personId: memberId } })).toBe(1); // only the pre-existing one
    });

    it('404s a second record — one row can mint at most one visit', async () => {
        const row = await park();
        expect((await POST(req(row.id, { action: 'record', departedAt: '2026-08-20T21:00:00.000Z' }), ctx(row.id))).status).toBe(200);
        expect((await POST(req(row.id, { action: 'record', departedAt: '2026-08-20T21:00:00.000Z' }), ctx(row.id))).status).toBe(404);
        expect(await prisma.visit.count({ where: { personId: memberId } })).toBe(1);
    });

    it('re-projects the parked presence event that shares the row clientEventId', async () => {
        const row = await park({ clientEventId: `evt-${TAG}-1` });
        await prisma.presenceEvent.create({
            data: {
                personId: memberId,
                occurredAt: new Date('2026-08-20T19:14:00.000Z'),
                direction: 'IN',
                source: 'SCANNER',
                clientEventId: `evt-${TAG}-1`,
                classification: 'PARKED_STALE',
            },
        });
        const res = await POST(req(row.id, { action: 'record', departedAt: '2026-08-20T21:00:00.000Z' }), ctx(row.id));
        expect(res.status).toBe(200);

        const ev = await prisma.presenceEvent.findUnique({ where: { clientEventId: `evt-${TAG}-1` } });
        const visit = await prisma.visit.findFirst({ where: { personId: memberId } });
        expect(ev?.classification).toBe('PROJECTED');
        expect(ev?.visitId).toBe(visit?.id);
    });

    it('409s an OUT-direction parked scan — a departure is not an arrival', async () => {
        const row = await park({ clientEventId: `evt-${TAG}-out` });
        await prisma.presenceEvent.create({
            data: {
                personId: memberId,
                occurredAt: new Date('2026-08-20T19:14:00.000Z'),
                direction: 'OUT',
                source: 'SCANNER',
                clientEventId: `evt-${TAG}-out`,
                classification: 'PARKED_STALE',
            },
        });
        const res = await POST(req(row.id, { action: 'record', departedAt: '2026-08-20T21:00:00.000Z' }), ctx(row.id));
        expect(res.status).toBe(409);
        expect(await prisma.visit.count({ where: { personId: memberId } })).toBe(0);
        expect((await prisma.rawBadgeLog.findUnique({ where: { id: row.id } }))?.reviewedAt).toBeNull();
    });

    it('409s leave-open when a LATER open visit exists — no second open visit, ever', async () => {
        const row = await park(); // parked 19:14
        await prisma.visit.create({
            data: { personId: memberId, arrivedAt: new Date('2026-08-20T20:00:00.000Z'), arrivedVia: 'SCANNER' },
        });
        const res = await POST(req(row.id, { action: 'record' }), ctx(row.id));
        expect(res.status).toBe(409);
        expect(await prisma.visit.count({ where: { personId: memberId, departedAt: null } })).toBe(1);
    });

    it('400s a visit longer than 24 hours', async () => {
        const row = await park();
        const res = await POST(req(row.id, { action: 'record', departedAt: '2026-08-22T21:00:00.000Z' }), ctx(row.id));
        expect(res.status).toBe(400);
        expect(await prisma.visit.count({ where: { personId: memberId } })).toBe(0);
    });

    it('writes the audit row and the departure presence event on a closed mint', async () => {
        const row = await park();
        const res = await POST(req(row.id, { action: 'record', departedAt: '2026-08-20T21:00:00.000Z' }), ctx(row.id));
        expect(res.status).toBe(200);
        const visit = await prisma.visit.findFirst({ where: { personId: memberId } });
        expect(visit?.departedVia).toBe('TYPED');
        const audit = await prisma.auditLog.findFirst({
            where: { tableName: 'Visit', affectedEntityId: visit!.id },
        });
        expect(audit?.actorId).toBe(keyholderId);
        const out = await prisma.presenceEvent.findFirst({
            where: { personId: memberId, direction: 'OUT' },
        });
        expect(out?.classification).toBe('PROJECTED');
        expect(out?.visitId).toBe(visit?.id);
    });

    it('a bodyless POST is still a plain dismiss', async () => {
        const row = await park();
        const res = await POST(req(row.id), ctx(row.id));
        expect(res.status).toBe(200);
        expect(await prisma.visit.count({ where: { personId: memberId } })).toBe(0);
        expect((await prisma.rawBadgeLog.findUnique({ where: { id: row.id } }))?.reviewedAt).not.toBeNull();
    });
});
