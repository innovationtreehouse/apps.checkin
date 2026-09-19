/**
 * @jest-environment node
 */
import { POST } from '../route';
import { authenticateRequest } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { processCheckin, processCheckout } from '@/lib/scan-service';

jest.mock('@/lib/auth', () => ({
    authenticateRequest: jest.fn(),
}));

jest.mock('@/lib/prisma', () => {
    const mock = {
        person: {
            findUnique: jest.fn(),
        },
        personMerge: {
            findUnique: jest.fn().mockResolvedValue(null),
        },
        rawBadgeLog: {
            create: jest.fn(),
            findFirst: jest.fn(),
            findUnique: jest.fn(),
        },
        visit: {
            findFirst: jest.fn(),
            aggregate: jest.fn(),
            count: jest.fn().mockResolvedValue(0),
        },
        systemMetricLog: {
            create: jest.fn().mockResolvedValue({}),
        },
        presenceEvent: {
            create: jest.fn().mockResolvedValue({ id: 1 }),
            update: jest.fn().mockResolvedValue({}),
        },
        // The route runs steps 4–6 inside a $transaction under a per-participant
        // advisory lock; the callback receives a tx client. For unit tests the
        // tx client is just this same mock, and the lock query is a no-op.
        $executeRaw: jest.fn().mockResolvedValue(1),
        $transaction: jest.fn(),
    };
    mock.$transaction.mockImplementation((cb: (tx: typeof mock) => unknown) => cb(mock));
    return mock;
});

jest.mock('@/lib/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    logBackendError: jest.fn(),
}));

jest.mock('@/lib/scan-service', () => ({
    processCheckin: jest.fn(),
    processCheckout: jest.fn(),
    finalizeFacilityClose: jest.fn().mockResolvedValue(undefined),
    SUPERVISION_CONFIRM_MS: 15_000,
    SUPERVISION_CONFIRM_DEADFRONT_MS: 1_000,
}));

describe('POST /api/scan', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should return 400 if the payload is not valid JSON', async () => {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'session', user: { id: '1' } });
        const req = new Request('http://localhost/api/scan', {
            method: 'POST',
            body: 'not-json'
        }) as unknown as import('next/server').NextRequest;

        const res = await POST(req);
        expect(res.status).toBe(400);

        const json = await res.json();
        expect(json.error).toBe('Invalid JSON payload.');
    });

    it('should return 400 if participantId is missing', async () => {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'session', user: { id: '1' } });
        const req = new Request('http://localhost/api/scan', {
            method: 'POST',
            body: JSON.stringify({ other: 'data' })
        }) as unknown as import('next/server').NextRequest;

        const res = await POST(req);
        expect(res.status).toBe(400);

        const json = await res.json();
        expect(json.error).toBe('A valid numeric participantId is required.');
    });

    it('should return 400 if participantId is not a number', async () => {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'session', user: { id: '1' } });
        const req = new Request('http://localhost/api/scan', {
            method: 'POST',
            body: JSON.stringify({ participantId: '123' })
        }) as unknown as import('next/server').NextRequest;

        const res = await POST(req);
        expect(res.status).toBe(400);

        const json = await res.json();
        expect(json.error).toBe('A valid numeric participantId is required.');
    });
    it('forwards a merged-away badge to the surviving live record and scans as the survivor', async () => {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'session', user: { id: '1' } });
        const req = new Request('http://localhost/api/scan', {
            method: 'POST',
            body: JSON.stringify({ participantId: 1 })
        }) as unknown as import('next/server').NextRequest;

        const survivor = { id: 99, mergedIntoId: null };
        (prisma.person.findUnique as jest.Mock).mockImplementation(({ where }: { where: { id: number } }) => {
            if (where.id === 1) return Promise.resolve({ id: 1, mergedIntoId: 99 });
            if (where.id === 99) return Promise.resolve(survivor);
            return Promise.resolve(null);
        });
        (prisma.rawBadgeLog.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.visit.findFirst as jest.Mock).mockResolvedValue(null);
        (processCheckin as jest.Mock).mockResolvedValue(new Response(JSON.stringify({ type: 'checkin' }), { status: 200 }));

        const res = await POST(req);
        expect(res.status).toBe(200);

        // Scanned, recorded, and checked in AS THE SURVIVOR (id 99), not the badge's own id (1).
        expect(processCheckin).toHaveBeenCalledWith(survivor, 'session', expect.anything(), expect.any(Date));
        expect(prisma.rawBadgeLog.create).toHaveBeenCalledWith({ data: { personId: 99, location: 'Main Entrance' } });
        expect(logger.info).toHaveBeenCalledWith('Scan forwarded from merged record', {
            badgeId: 1, tombstoneId: 99, survivorId: 99, hops: 1, viaArchive: false,
        });
    });

    // #1456 phase 2b. The tombstone walk above only runs because the merged-away
    // Person row still loads. Once 2b-3 deletes it, `findUnique` misses and the
    // 404 fires first — the badge is rejected at the door, which is the failure
    // the walk exists to prevent. These cover the archive branch that replaces it.
    describe('resolving a badge whose Person row no longer exists', () => {
        const scanReq = (participantId: number) => new Request('http://localhost/api/scan', {
            method: 'POST',
            body: JSON.stringify({ participantId }),
        }) as unknown as import('next/server').NextRequest;

        beforeEach(() => {
            (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'session', user: { id: '1' } });
            (prisma.rawBadgeLog.findFirst as jest.Mock).mockResolvedValue(null);
            (prisma.visit.findFirst as jest.Mock).mockResolvedValue(null);
            (processCheckin as jest.Mock).mockResolvedValue(new Response(JSON.stringify({ type: 'checkin' }), { status: 200 }));
        });

        it('follows the PersonMerge archive to the survivor and scans as them', async () => {
            const survivor = { id: 99, mergedIntoId: null };
            (prisma.person.findUnique as jest.Mock).mockImplementation(({ where }: { where: { id: number } }) =>
                Promise.resolve(where.id === 99 ? survivor : null));
            (prisma.personMerge.findUnique as jest.Mock).mockImplementation(({ where }: { where: { fromId: number } }) =>
                Promise.resolve(where.fromId === 1 ? { toId: 99 } : null));

            const res = await POST(scanReq(1));
            expect(res.status).toBe(200);

            expect(processCheckin).toHaveBeenCalledWith(survivor, 'session', expect.anything(), expect.any(Date));
            expect(prisma.rawBadgeLog.create).toHaveBeenCalledWith({ data: { personId: 99, location: 'Main Entrance' } });
            expect(logger.info).toHaveBeenCalledWith('Scan forwarded from merged record', {
                badgeId: 1, tombstoneId: null, survivorId: 99, hops: 1, viaArchive: true,
            });
        });

        // The two records coexist during 2b: an old tombstone Person row can point
        // at a survivor that was itself merged away and deleted later, so one chain
        // alternates between the two lookups.
        it('walks a chain that alternates between a tombstone row and the archive', async () => {
            const survivor = { id: 3, mergedIntoId: null };
            (prisma.person.findUnique as jest.Mock).mockImplementation(({ where }: { where: { id: number } }) => {
                if (where.id === 1) return Promise.resolve({ id: 1, mergedIntoId: 2 });  // tombstone kept
                if (where.id === 3) return Promise.resolve(survivor);
                return Promise.resolve(null);                                            // id 2 was deleted
            });
            (prisma.personMerge.findUnique as jest.Mock).mockImplementation(({ where }: { where: { fromId: number } }) =>
                Promise.resolve(where.fromId === 2 ? { toId: 3 } : null));

            const res = await POST(scanReq(1));
            expect(res.status).toBe(200);
            expect(processCheckin).toHaveBeenCalledWith(survivor, 'session', expect.anything(), expect.any(Date));
            expect(logger.info).toHaveBeenCalledWith('Scan forwarded from merged record', {
                badgeId: 1, tombstoneId: 2, survivorId: 3, hops: 2, viaArchive: false,
            });
        });

        it('caps an archive chain at 5 hops too', async () => {
            // 1->2->3->4->5->6->7, every Person row deleted, so it is archive-only.
            (prisma.person.findUnique as jest.Mock).mockResolvedValue(null);
            (prisma.personMerge.findUnique as jest.Mock).mockImplementation(({ where }: { where: { fromId: number } }) =>
                Promise.resolve(where.fromId < 7 ? { toId: where.fromId + 1 } : null));

            const res = await POST(scanReq(1));
            expect(res.status).toBe(409);

            const json = await res.json();
            expect(json.error).toContain('merged record');
            expect(json.error).toContain('7');
            expect(prisma.rawBadgeLog.create).not.toHaveBeenCalled();
            // Never fetches past the cap — same guarantee as the tombstone walk.
            expect(prisma.person.findUnique).not.toHaveBeenCalledWith({ where: { id: 7 } });
        });

        it('404s an id that is in neither table', async () => {
            (prisma.person.findUnique as jest.Mock).mockResolvedValue(null);
            (prisma.personMerge.findUnique as jest.Mock).mockResolvedValue(null);

            const res = await POST(scanReq(1));
            expect(res.status).toBe(404);
            expect((await res.json()).error).toContain('not found');
        });

        // A merge pointer that leads nowhere is a different fault from an unknown
        // badge: the record existed, so reissuing is the action, not "who is this".
        it('409s when a hop lands on an id in neither table', async () => {
            (prisma.person.findUnique as jest.Mock).mockImplementation(({ where }: { where: { id: number } }) =>
                Promise.resolve(where.id === 1 ? { id: 1, mergedIntoId: 42 } : null));
            (prisma.personMerge.findUnique as jest.Mock).mockResolvedValue(null);

            const res = await POST(scanReq(1));
            expect(res.status).toBe(409);
            expect((await res.json()).error).toContain('42');
        });
    });

    it('caps the merge chain walk at 5 hops and 409s with a reissue message rather than looping forever', async () => {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'session', user: { id: '1' } });
        const req = new Request('http://localhost/api/scan', {
            method: 'POST',
            body: JSON.stringify({ participantId: 1 })
        }) as unknown as import('next/server').NextRequest;

        // A 6-hop chain (1->2->3->4->5->6->7 live) needs a 6th hop to resolve — over the cap.
        const chain: Record<number, { id: number; mergedIntoId: number | null }> = {
            1: { id: 1, mergedIntoId: 2 },
            2: { id: 2, mergedIntoId: 3 },
            3: { id: 3, mergedIntoId: 4 },
            4: { id: 4, mergedIntoId: 5 },
            5: { id: 5, mergedIntoId: 6 },
            6: { id: 6, mergedIntoId: 7 },
            7: { id: 7, mergedIntoId: null },
        };
        (prisma.person.findUnique as jest.Mock).mockImplementation(({ where }: { where: { id: number } }) =>
            Promise.resolve(chain[where.id] ?? null));

        const res = await POST(req);
        expect(res.status).toBe(409);

        const json = await res.json();
        expect(json.error).toContain('merged record');
        expect(json.error).toContain('7');
        expect(prisma.rawBadgeLog.create).not.toHaveBeenCalled();
        expect(prisma.visit.findFirst).not.toHaveBeenCalled();
        // Never fetches past the cap (id 7 itself is never looked up).
        expect(prisma.person.findUnique).not.toHaveBeenCalledWith({ where: { id: 7 } });
    });

    it('does not walk the chain at all for an already-live participant', async () => {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'session', user: { id: '1' } });
        const req = new Request('http://localhost/api/scan', {
            method: 'POST',
            body: JSON.stringify({ participantId: 1 })
        }) as unknown as import('next/server').NextRequest;

        (prisma.person.findUnique as jest.Mock).mockResolvedValue({ id: 1, mergedIntoId: null });
        (prisma.rawBadgeLog.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.visit.findFirst as jest.Mock).mockResolvedValue(null);
        (processCheckin as jest.Mock).mockResolvedValue(new Response(JSON.stringify({ type: 'checkin' }), { status: 200 }));

        const res = await POST(req);
        expect(res.status).toBe(200);

        expect(prisma.person.findUnique).toHaveBeenCalledTimes(1);
        expect(logger.info).not.toHaveBeenCalled();
    });

    it('should silently ignore repeated scans within 3 seconds', async () => {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'session', user: { id: '1' } });
        const req = new Request('http://localhost/api/scan', {
            method: 'POST',
            body: JSON.stringify({ participantId: 1 })
        }) as unknown as import('next/server').NextRequest;

        (prisma.person.findUnique as jest.Mock).mockResolvedValue({ id: 1 });
        (prisma.rawBadgeLog.findFirst as jest.Mock).mockResolvedValue({ timestamp: new Date(Date.now() - 1000) });

        const res = await POST(req);
        expect(res.status).toBe(200);

        const json = await res.json();
        expect(json.type).toBe('ignored_debounce');
        expect(json.message).toBe('Scan ignored due to debounce.');
    });

    // Replayed-scan idempotency (docs/rules/attendance-checkin.md, kiosk
    // resilience). `replay: true` marks a redelivery; the try-first rule puts
    // clientEventId on the live attempt too, so the id alone never implies a replay.
    describe('replayed scans (clientEventId/scannedAt)', () => {
        function replayReq(overrides: Record<string, unknown> = {}) {
            return new Request('http://localhost/api/scan', {
                method: 'POST',
                body: JSON.stringify({ participantId: 1, clientEventId: 'evt-1', scannedAt: new Date().toISOString(), replay: true, ...overrides })
            }) as unknown as import('next/server').NextRequest;
        }

        beforeEach(() => {
            (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'kiosk' });
            (prisma.person.findUnique as jest.Mock).mockResolvedValue({ id: 1, mergedIntoId: null });
            (prisma.rawBadgeLog.findFirst as jest.Mock).mockResolvedValue(null);
        });

        it('acks a redelivered clientEventId as duplicate_ignored without re-toggling', async () => {
            (prisma.rawBadgeLog.findUnique as jest.Mock).mockResolvedValue({ id: 5, clientEventId: 'evt-1' });

            const res = await POST(replayReq());
            expect(res.status).toBe(200);
            const json = await res.json();
            expect(json.type).toBe('duplicate_ignored');
            expect(prisma.rawBadgeLog.create).not.toHaveBeenCalled();
            expect(processCheckin).not.toHaveBeenCalled();
        });

        it('dedups on clientEventId regardless of the replay flag (try-first contract)', async () => {
            (prisma.rawBadgeLog.findUnique as jest.Mock).mockResolvedValue({ id: 5, clientEventId: 'evt-1' });

            const res = await POST(replayReq({ replay: undefined }));
            expect((await res.json()).type).toBe('duplicate_ignored');
            expect(prisma.rawBadgeLog.create).not.toHaveBeenCalled();
        });

        it('rejects a non-boolean replay flag rather than guessing its truthiness', async () => {
            const res = await POST(replayReq({ replay: 'true' }));
            expect(res.status).toBe(400);
            expect((await res.json()).error).toContain('replay');
        });

        it('rejects replay:true without a clientEventId — it could neither dedup nor park', async () => {
            const res = await POST(replayReq({ clientEventId: undefined }));
            expect(res.status).toBe(400);
            expect(prisma.rawBadgeLog.create).not.toHaveBeenCalled();
        });

        // Without a usable scannedAt a replay would silently inherit server-now:
        // the freshness check passes trivially and the out-of-order guard
        // compares against now, so a stale replay toggles instead of parking.
        it('rejects replay:true without a scannedAt', async () => {
            const res = await POST(replayReq({ scannedAt: undefined }));
            expect(res.status).toBe(400);
            expect((await res.json()).error).toContain('scannedAt');
            expect(prisma.rawBadgeLog.create).not.toHaveBeenCalled();
        });

        it('rejects replay:true with an unparseable scannedAt', async () => {
            const res = await POST(replayReq({ scannedAt: 'not-a-date' }));
            expect(res.status).toBe(400);
            expect((await res.json()).error).toContain('scannedAt');
            expect(prisma.rawBadgeLog.create).not.toHaveBeenCalled();
        });

        it('toggles a fresh replay using scannedAt as the visit time', async () => {
            (prisma.rawBadgeLog.findUnique as jest.Mock).mockResolvedValue(null);
            (prisma.visit.findFirst as jest.Mock).mockResolvedValue(null);
            (prisma.visit.aggregate as jest.Mock).mockResolvedValue({ _max: { arrivedAt: null, departedAt: null } });
            (processCheckin as jest.Mock).mockResolvedValue(new Response(JSON.stringify({ type: 'checkin' }), { status: 200 }));

            const scannedAt = new Date(Date.now() - 60_000).toISOString();
            const res = await POST(replayReq({ scannedAt }));
            expect(res.status).toBe(200);

            expect(prisma.rawBadgeLog.create).toHaveBeenCalledWith({
                data: { personId: 1, location: 'Main Entrance', clientEventId: 'evt-1', timestamp: new Date(scannedAt) },
            });
            expect(processCheckin).toHaveBeenCalledWith({ id: 1, mergedIntoId: null }, 'kiosk', expect.anything(), new Date(scannedAt));
        });

        it('parks a replay older than the freshness window instead of toggling', async () => {
            (prisma.rawBadgeLog.findUnique as jest.Mock).mockResolvedValue(null);

            const scannedAt = new Date(Date.now() - 20 * 60_000).toISOString(); // 20 min ago > 10 min W
            const res = await POST(replayReq({ scannedAt }));
            expect(res.status).toBe(200);
            const json = await res.json();
            expect(json.type).toBe('parked');

            expect(prisma.rawBadgeLog.create).toHaveBeenCalledWith({
                data: { personId: 1, location: 'Main Entrance', clientEventId: 'evt-1', timestamp: new Date(scannedAt), reviewReason: 'stale_replay' },
            });
            expect(prisma.visit.findFirst).not.toHaveBeenCalled();
            expect(processCheckin).not.toHaveBeenCalled();
            expect(processCheckout).not.toHaveBeenCalled();
        });

        it('parks a fresh replay whose scannedAt is older than newer visit activity (out-of-order guard)', async () => {
            (prisma.rawBadgeLog.findUnique as jest.Mock).mockResolvedValue(null);
            const scannedAt = new Date(Date.now() - 5 * 60_000); // within W
            (prisma.visit.aggregate as jest.Mock).mockResolvedValue({
                _max: {
                    arrivedAt: new Date(Date.now() - 2 * 60_000),
                    departedAt: new Date(Date.now() - 60_000), // newer than scannedAt
                },
            });

            const res = await POST(replayReq({ scannedAt: scannedAt.toISOString() }));
            expect(res.status).toBe(200);
            const json = await res.json();
            expect(json.type).toBe('parked');
            expect(prisma.rawBadgeLog.create).toHaveBeenCalledWith(
                expect.objectContaining({ data: expect.objectContaining({ reviewReason: 'out_of_order' }) })
            );
            expect(processCheckin).not.toHaveBeenCalled();
            expect(processCheckout).not.toHaveBeenCalled();
        });

        it('a same-body legacy scan (no clientEventId) is unaffected — no dedup pre-read, no park branch', async () => {
            (prisma.visit.findFirst as jest.Mock).mockResolvedValue(null);
            (processCheckin as jest.Mock).mockResolvedValue(new Response(JSON.stringify({ type: 'checkin' }), { status: 200 }));

            const res = await POST(replayReq({ clientEventId: undefined, scannedAt: undefined, replay: undefined }));
            expect(res.status).toBe(200);

            expect(prisma.rawBadgeLog.findUnique).not.toHaveBeenCalled();
            expect(prisma.rawBadgeLog.create).toHaveBeenCalledWith({ data: { personId: 1, location: 'Main Entrance' } });
        });

        it('an empty-string clientEventId normalizes to null and is treated as a live scan, not a replay', async () => {
            (prisma.visit.findFirst as jest.Mock).mockResolvedValue(null);
            (processCheckin as jest.Mock).mockResolvedValue(new Response(JSON.stringify({ type: 'checkin' }), { status: 200 }));

            const res = await POST(replayReq({ clientEventId: '', replay: undefined }));
            expect(res.status).toBe(200);

            expect(prisma.rawBadgeLog.findUnique).not.toHaveBeenCalled();
            expect(prisma.rawBadgeLog.create).toHaveBeenCalledWith({ data: { personId: 1, location: 'Main Entrance' } });
        });
    });

    // #1347 PR-2 / Q10 — server-side DLQ ingest. A terminally-failed outbox
    // row rides the same endpoint with `dead: true` instead of `replay: true`;
    // it only ever parks, sharing replay's clientEventId/scannedAt identity so
    // a re-sent dead row dedups on the same pre-read/P2002 path.
    describe('dead-lettered scan ingest (Q10)', () => {
        function deadReq(overrides: Record<string, unknown> = {}) {
            return new Request('http://localhost/api/scan', {
                method: 'POST',
                body: JSON.stringify({ participantId: 1, clientEventId: 'evt-dead', scannedAt: new Date().toISOString(), dead: true, deadStatus: 404, ...overrides })
            }) as unknown as import('next/server').NextRequest;
        }

        beforeEach(() => {
            (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'kiosk' });
            (prisma.person.findUnique as jest.Mock).mockResolvedValue({ id: 1, mergedIntoId: null });
            (prisma.rawBadgeLog.findFirst as jest.Mock).mockResolvedValue(null);
            (prisma.rawBadgeLog.findUnique as jest.Mock).mockResolvedValue(null);
        });

        it('parks a dead-lettered event with a client_dead:<status> reviewReason and never toggles a visit', async () => {
            const scannedAt = new Date(Date.now() - 60_000).toISOString();
            const res = await POST(deadReq({ scannedAt }));
            expect(res.status).toBe(200);
            expect((await res.json()).type).toBe('parked');

            expect(prisma.rawBadgeLog.create).toHaveBeenCalledWith({
                data: { personId: 1, location: 'Main Entrance', clientEventId: 'evt-dead', timestamp: new Date(scannedAt), reviewReason: 'client_dead:404' },
            });
            expect(prisma.visit.findFirst).not.toHaveBeenCalled();
            expect(processCheckin).not.toHaveBeenCalled();
            expect(processCheckout).not.toHaveBeenCalled();
        });

        it('falls back to client_dead:unknown when deadStatus is missing or non-numeric', async () => {
            const res = await POST(deadReq({ deadStatus: undefined }));
            expect((await res.json()).type).toBe('parked');
            expect(prisma.rawBadgeLog.create).toHaveBeenCalledWith(
                expect.objectContaining({ data: expect.objectContaining({ reviewReason: 'client_dead:unknown' }) })
            );
        });

        it('rejects dead:true together with replay:true', async () => {
            const res = await POST(deadReq({ replay: true }));
            expect(res.status).toBe(400);
            expect((await res.json()).error).toContain('exclusive');
            expect(prisma.rawBadgeLog.create).not.toHaveBeenCalled();
        });

        it('rejects a non-boolean dead flag', async () => {
            const res = await POST(deadReq({ dead: 'yes' }));
            expect(res.status).toBe(400);
            expect((await res.json()).error).toContain('dead');
        });

        it('rejects dead:true without a clientEventId', async () => {
            const res = await POST(deadReq({ clientEventId: undefined }));
            expect(res.status).toBe(400);
            expect(prisma.rawBadgeLog.create).not.toHaveBeenCalled();
        });

        it('rejects dead:true without a scannedAt', async () => {
            const res = await POST(deadReq({ scannedAt: undefined }));
            expect(res.status).toBe(400);
            expect((await res.json()).error).toContain('scannedAt');
            expect(prisma.rawBadgeLog.create).not.toHaveBeenCalled();
        });

        it('is not swallowed by the 3s debounce -- the touch must never be silently dropped', async () => {
            (prisma.rawBadgeLog.findFirst as jest.Mock).mockResolvedValue({ timestamp: new Date() }); // would otherwise debounce
            const res = await POST(deadReq());
            expect((await res.json()).type).toBe('parked');
            expect(prisma.rawBadgeLog.create).toHaveBeenCalled();
        });

        it('re-sending an already-recorded dead row dedups instead of double-parking', async () => {
            (prisma.rawBadgeLog.findUnique as jest.Mock).mockResolvedValue({ id: 9, clientEventId: 'evt-dead' });
            const res = await POST(deadReq());
            expect((await res.json()).type).toBe('duplicate_ignored');
            expect(prisma.rawBadgeLog.create).not.toHaveBeenCalled();
        });

        // The pre-read keys only on clientEventId, not on which flag sent it --
        // a dead-lettered resend of an id already recorded via a normal replay
        // (or a live scan) dedups exactly the same way.
        it('dedups a dead row whose clientEventId already exists from a normal replay', async () => {
            (prisma.rawBadgeLog.findUnique as jest.Mock).mockResolvedValue({ id: 9, clientEventId: 'evt-dead', reviewReason: null });
            const res = await POST(deadReq());
            expect((await res.json()).type).toBe('duplicate_ignored');
            expect(prisma.rawBadgeLog.create).not.toHaveBeenCalled();
        });
    });

    // The live kiosk scan carries clientEventId (D4 try-first) but no replay
    // flag: it must dedup, and otherwise behave exactly like a legacy live scan.
    describe('live scans carrying a clientEventId (no replay flag)', () => {
        function liveReq(overrides: Record<string, unknown> = {}) {
            return new Request('http://localhost/api/scan', {
                method: 'POST',
                body: JSON.stringify({ participantId: 1, clientEventId: 'evt-live', scannedAt: new Date().toISOString(), ...overrides })
            }) as unknown as import('next/server').NextRequest;
        }

        beforeEach(() => {
            (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'kiosk' });
            (prisma.person.findUnique as jest.Mock).mockResolvedValue({ id: 1, mergedIntoId: null });
            (prisma.rawBadgeLog.findFirst as jest.Mock).mockResolvedValue(null);
            (prisma.rawBadgeLog.findUnique as jest.Mock).mockResolvedValue(null);
            (prisma.visit.findFirst as jest.Mock).mockResolvedValue(null);
            (processCheckin as jest.Mock).mockResolvedValue(new Response(JSON.stringify({ type: 'checkin' }), { status: 200 }));
        });

        it('records the dedup key but stamps server-now, never the kiosk scannedAt', async () => {
            const res = await POST(liveReq({ scannedAt: new Date(Date.now() - 60_000).toISOString() }));
            expect(res.status).toBe(200);

            // No `timestamp` override -> the column default (now).
            expect(prisma.rawBadgeLog.create).toHaveBeenCalledWith({
                data: { personId: 1, location: 'Main Entrance', clientEventId: 'evt-live' },
            });
        });

        it('is never parked by the freshness window, however old its scannedAt', async () => {
            const res = await POST(liveReq({ scannedAt: new Date(Date.now() - 20 * 60_000).toISOString() }));
            expect((await res.json()).type).toBe('checkin');
            expect(prisma.visit.aggregate).not.toHaveBeenCalled();
            expect(processCheckin).toHaveBeenCalled();
        });

        it('is never parked by the out-of-order guard, and checks out as live (no replay id)', async () => {
            (prisma.visit.findFirst as jest.Mock).mockResolvedValue({ id: 7 });
            (prisma.visit.aggregate as jest.Mock).mockResolvedValue({
                _max: { arrivedAt: new Date(), departedAt: new Date() },
            });
            (processCheckout as jest.Mock).mockResolvedValue(new Response(JSON.stringify({ type: 'checkout' }), { status: 200 }));

            const res = await POST(liveReq());
            expect((await res.json()).type).toBe('checkout');
            // Last arg null => processCheckout takes the live warn/confirm path.
            expect(processCheckout).toHaveBeenCalledWith({ id: 1, mergedIntoId: null }, 7, 'kiosk', expect.anything(), null, expect.any(Date), null, false);
        });

        it('still dedups a clientEventId already recorded server-side', async () => {
            (prisma.rawBadgeLog.findUnique as jest.Mock).mockResolvedValue({ id: 5, clientEventId: 'evt-live' });

            const res = await POST(liveReq());
            expect((await res.json()).type).toBe('duplicate_ignored');
            expect(prisma.rawBadgeLog.create).not.toHaveBeenCalled();
        });
    });

    describe('force-close confirm token', () => {
        const scanReq = (body: Record<string, unknown>) => new Request('http://localhost/api/scan', {
            method: 'POST',
            body: JSON.stringify(body),
        }) as unknown as import('next/server').NextRequest;

        beforeEach(() => {
            (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'session', user: { id: '1' } });
            (prisma.person.findUnique as jest.Mock).mockResolvedValue({ id: 1, mergedIntoId: null });
            // Inside the 3s debounce window — only a live token gets past it.
            (prisma.rawBadgeLog.findFirst as jest.Mock).mockResolvedValue({ timestamp: new Date() });
            (prisma.visit.findFirst as jest.Mock).mockResolvedValue({ id: 7 });
            (processCheckout as jest.Mock).mockResolvedValue(
                new Response(JSON.stringify({ type: 'checkout', facilityClosed: true }), { status: 200 }));
        });

        it('lets a scan matching a live token through the debounce and forwards it', async () => {
            (prisma.visit.count as jest.Mock).mockResolvedValue(1); // token matches an open visit

            const res = await POST(scanReq({ participantId: 1, forceCloseToken: 'tok-1' }));

            expect((await res.json()).facilityClosed).toBe(true);
            expect(processCheckout).toHaveBeenCalledWith({ id: 1, mergedIntoId: null }, 7, 'session', expect.anything(), 'tok-1', expect.any(Date), null, false);
        });

        it('debounces a spent or unknown token, so a stray second read cannot re-toggle', async () => {
            (prisma.visit.count as jest.Mock).mockResolvedValue(0); // nothing holds this token

            const res = await POST(scanReq({ participantId: 1, forceCloseToken: 'tok-1' }));

            expect((await res.json()).type).toBe('ignored_debounce');
            expect(processCheckout).not.toHaveBeenCalled();
        });

        it('treats a non-string token as no token at all', async () => {
            (prisma.visit.count as jest.Mock).mockResolvedValue(0); // no live token, no fresh supervision stamp either
            const res = await POST(scanReq({ participantId: 1, forceCloseToken: 42 }));

            expect((await res.json()).type).toBe('ignored_debounce');
            expect(processCheckout).not.toHaveBeenCalled();
        });

        // §5.23a: the outbox persists the token with the queued event, so a
        // confirm given before the outage arrives on the replay and closes.
        it('forwards a replayed scan\'s token so a pre-outage confirm still closes', async () => {
            (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'kiosk' });
            (prisma.rawBadgeLog.findFirst as jest.Mock).mockResolvedValue(null);
            (prisma.rawBadgeLog.findUnique as jest.Mock).mockResolvedValue(null);
            (prisma.visit.aggregate as jest.Mock).mockResolvedValue({ _max: { arrivedAt: null, departedAt: null } });

            const scannedAt = new Date(Date.now() - 60_000).toISOString();
            const res = await POST(scanReq({
                participantId: 1, clientEventId: 'evt-q', scannedAt, replay: true, forceCloseToken: 'tok-q',
            }));

            expect((await res.json()).facilityClosed).toBe(true);
            expect(processCheckout).toHaveBeenCalledWith(
                { id: 1, mergedIntoId: null }, 7, 'kiosk', expect.anything(), 'tok-q', new Date(scannedAt), 'evt-q', false);
        });

        // Precedence, pinned deliberately: §2's freshness window W runs BEFORE
        // the token is ever looked at, so a confirm queued through an outage
        // longer than W parks for review rather than closing hours late. The
        // token exempts a replay from the park in processCheckout, not from W.
        it('still parks a token-carrying replay that is older than the freshness window', async () => {
            (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'kiosk' });
            (prisma.rawBadgeLog.findFirst as jest.Mock).mockResolvedValue(null);
            (prisma.rawBadgeLog.findUnique as jest.Mock).mockResolvedValue(null);

            const res = await POST(scanReq({
                participantId: 1,
                clientEventId: 'evt-old',
                scannedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
                replay: true,
                forceCloseToken: 'tok-q',
            }));

            expect((await res.json()).type).toBe('parked');
            expect(processCheckout).not.toHaveBeenCalled();
        });
    });

    // #1347 PR-0 / Q16 remainder: the supervision confirm inherited the same
    // debounce swallow the force-close confirm has a token for. The exemption
    // is tied to a fresh supervisionWarnedAt stamp, no second token minted.
    describe('supervision confirm exemption from the debounce', () => {
        const scanReq = (body: Record<string, unknown>) => new Request('http://localhost/api/scan', {
            method: 'POST',
            body: JSON.stringify(body),
        }) as unknown as import('next/server').NextRequest;

        beforeEach(() => {
            (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'session', user: { id: '1' } });
            (prisma.person.findUnique as jest.Mock).mockResolvedValue({ id: 1, mergedIntoId: null });
            // Inside the 3s debounce window -- only a stamp past the dead-front floor gets past it.
            (prisma.rawBadgeLog.findFirst as jest.Mock).mockResolvedValue({ timestamp: new Date() });
            (prisma.visit.findFirst as jest.Mock).mockResolvedValue({ id: 7 });
            (processCheckout as jest.Mock).mockResolvedValue(
                new Response(JSON.stringify({ type: 'checkout' }), { status: 200 }));
        });

        // Simulates a REAL supervisionWarnedAt of the given age against
        // whatever [gte, lte] range route.ts actually constructs, instead of
        // a blanket mockResolvedValue -- a dropped or loosened filter fails
        // this the same way it would fail against a real database.
        function mockCountForWarnedAtAge(ageMs: number) {
            const warnedAt = new Date(Date.now() - ageMs);
            (prisma.visit.count as jest.Mock).mockImplementation(
                ({ where }: { where: { supervisionWarnedAt?: { gte: Date; lte?: Date } } }) => {
                    const range = where.supervisionWarnedAt;
                    // No lte in the where clause means no upper bound, same as a
                    // real Prisma query -- so a dropped floor doesn't false-fail
                    // this helper, only the case it actually breaks (below).
                    const pastFloor = !range?.lte || warnedAt <= range.lte;
                    return Promise.resolve(range && warnedAt >= range.gte && pastFloor ? 1 : 0);
                }
            );
        }

        it('exempts a scan 2s after a supervision warning, past the dead-front floor', async () => {
            mockCountForWarnedAtAge(2000);

            const res = await POST(scanReq({ participantId: 1 }));

            expect((await res.json()).type).toBe('checkout');
            expect(processCheckout).toHaveBeenCalledWith({ id: 1, mergedIntoId: null }, 7, 'session', expect.anything(), null, expect.any(Date), null, false);
            expect(prisma.visit.count).toHaveBeenCalledWith(expect.objectContaining({
                where: expect.objectContaining({
                    personId: 1,
                    departedAt: null,
                    deletedAt: null,
                    supervisionWarnedAt: { gte: expect.any(Date), lte: expect.any(Date) },
                }),
            }));
        });

        // Fable review finding (2026-08-21): a USB hardware double-read of the
        // WARNING scan itself (duplicate keystrokes ~300-800ms apart, no client
        // dedup) must NOT read as a confirm -- pre-PR-0 it debounced, and the
        // fix must not regress that into an unacknowledged auto-departure.
        it('debounces a second badge 500ms after the warning -- a hardware double-read dead front', async () => {
            mockCountForWarnedAtAge(500);

            const res = await POST(scanReq({ participantId: 1 }));

            expect((await res.json()).type).toBe('ignored_debounce');
            expect(processCheckout).not.toHaveBeenCalled();
        });

        it('still debounces an ordinary double-tap with no fresh stamp and no token', async () => {
            (prisma.visit.count as jest.Mock).mockResolvedValue(0);

            const res = await POST(scanReq({ participantId: 1 }));

            expect((await res.json()).type).toBe('ignored_debounce');
            expect(processCheckout).not.toHaveBeenCalled();
        });
    });
});
