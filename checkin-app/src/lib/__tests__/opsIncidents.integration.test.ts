/**
 * @jest-environment node
 */
/**
 * The incident engine against a real Postgres: runs evaluated at the same time
 * leave one open incident per key, and a closed one reopens in place.
 */
import prisma from '@/lib/prisma';
import { evaluateIncidents, type Delivery, type RunReport } from '../opsIncidents';

const CAUSE = 'ops-incident-engine-int';
const KEY = `${CAUSE}:connection`;

const report: RunReport = { lanes: ['expense'], failures: [{ lane: 'expense', cause: CAUSE, kind: 'connection', code: 'AUTH', count: 1 }] };
const delivery = (now: Date): Delivery => ({ send: async () => true, alertTo: ['alerts@example.org'], boardTo: [], timeZone: 'UTC', now });

describe('incident engine (real DB)', () => {
    afterEach(async () => {
        await prisma.opsIncident.deleteMany({ where: { cause: CAUSE } });
    });

    it('keeps one open incident per key when runs evaluate at the same time', async () => {
        const now = new Date();
        await Promise.all([evaluateIncidents(report, delivery(now)), evaluateIncidents(report, delivery(now)), evaluateIncidents(report, delivery(now))]);

        expect(await prisma.opsIncident.count({ where: { openKey: KEY } })).toBe(1);
    });

    it('closes the incident on a clean run and reopens the same row when it is back within a day', async () => {
        const t0 = new Date();
        await evaluateIncidents(report, delivery(t0));
        await evaluateIncidents({ lanes: ['expense'], failures: [] }, delivery(new Date(t0.getTime() + 60_000)));
        const closed = await prisma.opsIncident.findFirstOrThrow({ where: { key: KEY } });
        expect(closed).toMatchObject({ openKey: null, closedAt: expect.any(Date), recoveryNotifiedAt: expect.any(Date) });

        await evaluateIncidents(report, delivery(new Date(t0.getTime() + 120_000)));
        const rows = await prisma.opsIncident.findMany({ where: { key: KEY } });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: closed.id, openKey: KEY, closedAt: null, runsSeen: 2 });
    });
});
