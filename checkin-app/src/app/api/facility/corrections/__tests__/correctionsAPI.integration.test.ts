/**
 * @jest-environment node
 */
/**
 * Integration test for GET /api/facility/corrections (AT12, #1258).
 *
 * NOTE: this route depends on its `defineRoute` registry entry, which ships in
 * its own boundary-isolation PR ahead of this one (AGENTS.md). Until that PR
 * merges, `handler()` has no registry entry to resolve and every case here
 * gets a 500 instead of its expected status — that is the intended sequencing,
 * not a bug in this file.
 *
 * Covers: auth rejection (401/403), the tableName='Visit' pin (a Person audit
 * row must never appear), the flagged filter (first JSON-path filter in the
 * repo), the synthesized bag (oldData never rides; newData is rebuilt to
 * {type, significance}; before/after Visit times are extracted from the raw
 * blobs), and Person name resolution.
 */
import { GET } from '@/app/api/facility/corrections/route';
import prisma from '@/lib/prisma';
import type { Prisma } from '@/generated/prisma/client';
import { SYSTEM_ACTOR } from '@/lib/auditActor';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/auth-options', () => ({ authOptions: {} }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockSession = require('next-auth/next').getServerSession;

const TAG = 'corrections-test';

function nextReq(params: Record<string, string> = {}) {
    const url = new URL('http://localhost/api/facility/corrections');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return new Request(url) as unknown as import('next/server').NextRequest;
}

describe('GET /api/facility/corrections', () => {
    let boardId: number;
    let selfId: number;
    let leadId: number;
    const personIds: number[] = [];
    const auditIds: number[] = [];
    const householdIds: number[] = [];

    beforeAll(async () => {
        const board = await prisma.person.create({
            data: { name: 'Corr Board', email: `board-${TAG}@example.com`, isBoardMember: true, household: { create: { name: 'Test HH' } } },
        });
        boardId = board.id;
        householdIds.push(board.householdId);
        personIds.push(boardId);

        const self = await prisma.person.create({
            data: { name: 'Corr Self', email: `self-${TAG}@example.com`, household: { create: { name: 'Test HH' } } },
        });
        selfId = self.id;
        householdIds.push(self.householdId);
        personIds.push(selfId);

        const lead = await prisma.person.create({
            data: { name: 'Corr Lead', email: `lead-${TAG}@example.com`, household: { create: { name: 'Test HH' } } },
        });
        leadId = lead.id;
        householdIds.push(lead.householdId);
        personIds.push(leadId);
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
    });

    afterAll(async () => {
        await prisma.auditLog.deleteMany({ where: { id: { in: auditIds } } });
        await prisma.person.deleteMany({ where: { id: { in: personIds } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    });

    async function seed(data: Prisma.AuditLogCreateInput) {
        const row = await prisma.auditLog.create({ data });
        auditIds.push(row.id);
        return row;
    }

    it('401 without a session', async () => {
        mockSession.mockResolvedValue(null);
        const res = await GET(nextReq());
        expect(res.status).toBe(401);
    });

    it('403 for an authenticated non-board, non-sysadmin caller', async () => {
        mockSession.mockResolvedValue({ user: { id: selfId } });
        const res = await GET(nextReq());
        expect(res.status).toBe(403);
    });

    it('pins tableName to Visit — a Person audit row never appears', async () => {
        const now = new Date();
        await seed({
            actorId: boardId, action: 'EDIT', tableName: 'Person', affectedEntityId: selfId,
            timestamp: now,
            oldData: { name: 'Old Name' }, newData: { name: 'New Name' },
        });
        const visitRow = await seed({
            actorId: selfId, action: 'EDIT', tableName: 'Visit', affectedEntityId: 1,
            secondaryAffectedEntity: selfId, timestamp: now,
            oldData: { id: 1, personId: selfId, arrivedAt: '2026-01-01T10:00:00.000Z', departedAt: null, arrivedVia: 'SCANNER' },
            newData: { id: 1, personId: selfId, arrivedAt: '2026-01-01T10:00:00.000Z', departedAt: '2026-01-01T12:00:00.000Z', type: 'self_correction' },
        });

        const res = await GET(nextReq({ from: '2000-01-01', to: '2035-01-01', flagged: 'false' }));
        expect(res.status).toBe(200);
        const body = await res.json();
        const ids = body.AuditLog.map((r: { id: number }) => r.id);
        expect(ids).toContain(visitRow.id);
        expect(ids.every((id: number) => id !== undefined)).toBe(true);
        expect(body.AuditLog.every((r: { tableName: string }) => r.tableName === 'Visit')).toBe(true);
    });

    // SYSTEM_ACTOR is a sentinel id, not a person. If it ever re-enters the person
    // batch the row renders as Actor "Person #0" with a Proxy badge — an automated
    // sweep displayed as one person editing another's record, which is the single
    // question this screen exists to answer.
    it('carries a system write without resolving the sentinel to a person', async () => {
        const now = new Date();
        const systemRow = await seed({
            actorId: SYSTEM_ACTOR, actorSystem: 'cron:nightly',
            action: 'EDIT', tableName: 'Visit', affectedEntityId: 7,
            secondaryAffectedEntity: selfId, timestamp: now,
            oldData: { id: 7, personId: selfId, arrivedAt: '2026-06-01T09:00:00.000Z', departedAt: null },
            newData: { id: 7, personId: selfId, arrivedAt: '2026-06-01T09:00:00.000Z', departedAt: '2026-06-01T23:59:00.000Z', type: 'facility_close' },
        });

        const res = await GET(nextReq({ from: '2000-01-01', to: '2035-01-01', flagged: 'false' }));
        expect(res.status).toBe(200);
        const body = await res.json();

        const entry = body.AuditLog.find((r: { id: number }) => r.id === systemRow.id);
        expect(entry).toBeDefined();
        expect(entry.actorId).toBe(SYSTEM_ACTOR);
        // actorSystem is internal-tier and inside the granted band, so it ships and
        // the page can name the path instead of inventing a person.
        expect(entry.actorSystem).toBe('cron:nightly');
        expect(body.Person.some((p: { id: number }) => p.id === SYSTEM_ACTOR)).toBe(false);
        // The subject still resolves — only the actor is a sentinel.
        expect(body.Person.some((p: { id: number }) => p.id === selfId)).toBe(true);
    });

    it('never ships oldData, and rebuilds newData down to {type, significance}', async () => {
        const row = await seed({
            actorId: leadId, action: 'EDIT', tableName: 'Visit', affectedEntityId: 2,
            secondaryAffectedEntity: selfId, timestamp: new Date(),
            oldData: { id: 2, personId: selfId, arrivedAt: '2026-02-01T09:00:00.000Z', departedAt: '2026-02-01T11:00:00.000Z', arrivedVia: 'SCANNER', departedVia: 'SCANNER' },
            newData: { id: 2, personId: selfId, arrivedAt: '2026-02-01T09:00:00.000Z', departedAt: '2026-02-01T15:00:00.000Z', type: 'lead_attendance_correction', significance: { score: 600, flagged: true } },
        });

        const res = await GET(nextReq({ from: '2000-01-01', to: '2035-01-01', flagged: 'false' }));
        expect(res.status).toBe(200);
        const body = await res.json();
        const entry = body.AuditLog.find((r: { id: number }) => r.id === row.id);
        expect(entry).toBeDefined();
        expect(entry.oldData).toBeUndefined();
        expect(Object.keys(entry.newData).sort()).toEqual(['significance', 'type']);
        expect(entry.newData.type).toBe('lead_attendance_correction');
        expect(entry.newData.significance).toEqual({ score: 600, flagged: true });
    });

    it('extracts before/after Visit times from the raw blobs, aligned by index with AuditLog', async () => {
        const row = await seed({
            actorId: selfId, action: 'EDIT', tableName: 'Visit', affectedEntityId: 3,
            secondaryAffectedEntity: selfId, timestamp: new Date(),
            oldData: { id: 3, personId: selfId, participantId: selfId, synthetic: false, arrivedAt: '2026-03-01T09:00:00.000Z', departedAt: null, arrivedVia: 'SCANNER' },
            newData: { id: 3, personId: selfId, status: 'CLOSED', arrivedAt: '2026-03-01T09:00:00.000Z', departedAt: '2026-03-01T17:00:00.000Z', arrivedVia: 'SCANNER', type: 'self_correction' },
        });

        const res = await GET(nextReq({ from: '2000-01-01', to: '2035-01-01', flagged: 'false' }));
        const body = await res.json();
        expect(body.Visit.length).toBe(body.AuditLog.length);

        const idx = body.AuditLog.findIndex((r: { id: number }) => r.id === row.id);
        const [before, after] = body.Visit[idx];
        // Non-Visit blob fields (participantId, synthetic, status) never ride.
        expect(before).not.toHaveProperty('participantId');
        expect(before).not.toHaveProperty('synthetic');
        expect(after).not.toHaveProperty('status');
        expect(before.arrivedAt).toBe('2026-03-01T09:00:00.000Z');
        expect(before.departedAt).toBeNull();
        expect(after.departedAt).toBe('2026-03-01T17:00:00.000Z');
    });

    it('flagged=true returns only rows scored significant', async () => {
        const flagged = await seed({
            actorId: selfId, action: 'DELETE', tableName: 'Visit', affectedEntityId: 4,
            secondaryAffectedEntity: selfId, timestamp: new Date(),
            oldData: { id: 4, personId: selfId, arrivedAt: '2026-04-01T09:00:00.000Z', departedAt: '2026-04-01T17:00:00.000Z' },
            newData: { type: 'self_correction', significance: { score: 900, flagged: true } },
        });
        const unflagged = await seed({
            actorId: selfId, action: 'EDIT', tableName: 'Visit', affectedEntityId: 5,
            secondaryAffectedEntity: selfId, timestamp: new Date(),
            oldData: { id: 5, personId: selfId, arrivedAt: '2026-04-02T09:00:00.000Z', departedAt: '2026-04-02T09:05:00.000Z' },
            newData: { id: 5, personId: selfId, arrivedAt: '2026-04-02T09:00:00.000Z', departedAt: '2026-04-02T09:10:00.000Z', type: 'self_correction', significance: { score: 5, flagged: false } },
        });

        const flaggedRes = await GET(nextReq({ from: '2000-01-01', to: '2035-01-01', flagged: 'true' }));
        const flaggedBody = await flaggedRes.json();
        const flaggedIds = flaggedBody.AuditLog.map((r: { id: number }) => r.id);
        expect(flaggedIds).toContain(flagged.id);
        expect(flaggedIds).not.toContain(unflagged.id);

        const allRes = await GET(nextReq({ from: '2000-01-01', to: '2035-01-01', flagged: 'false' }));
        const allBody = await allRes.json();
        const allIds = allBody.AuditLog.map((r: { id: number }) => r.id);
        expect(allIds).toEqual(expect.arrayContaining([flagged.id, unflagged.id]));
    });

    it('resolves actor and subject names via Person, batched', async () => {
        const row = await seed({
            actorId: leadId, action: 'EDIT', tableName: 'Visit', affectedEntityId: 6,
            secondaryAffectedEntity: selfId, timestamp: new Date(),
            oldData: { id: 6, personId: selfId, arrivedAt: '2026-05-01T09:00:00.000Z' },
            newData: { id: 6, personId: selfId, arrivedAt: '2026-05-01T09:00:00.000Z', type: 'lead_attendance_correction' },
        });

        const res = await GET(nextReq({ from: '2000-01-01', to: '2035-01-01', flagged: 'false' }));
        const body = await res.json();
        expect(body.AuditLog.some((r: { id: number }) => r.id === row.id)).toBe(true);
        const names = new Map(body.Person.map((p: { id: number; name: string }) => [p.id, p.name]));
        expect(names.get(leadId)).toBe('Corr Lead');
        expect(names.get(selfId)).toBe('Corr Self');
    });

    it('excludes rows outside the requested date range', async () => {
        const old = await seed({
            actorId: selfId, action: 'EDIT', tableName: 'Visit', affectedEntityId: 7,
            secondaryAffectedEntity: selfId, timestamp: new Date('2000-06-01T00:00:00.000Z'),
            oldData: { id: 7 }, newData: { id: 7, type: 'self_correction' },
        });

        const res = await GET(nextReq({ from: '2030-01-01', to: '2035-01-01', flagged: 'false' }));
        const body = await res.json();
        expect(body.AuditLog.some((r: { id: number }) => r.id === old.id)).toBe(false);
    });

    it('400s on an invalid period', async () => {
        const res = await GET(nextReq({ period: 'day' }));
        expect(res.status).toBe(400);
    });

    it('400s on an invalid date', async () => {
        const res = await GET(nextReq({ from: 'not-a-date' }));
        expect(res.status).toBe(400);
    });
});
