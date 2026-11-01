/**
 * @jest-environment node
 */
/**
 * The scan acknowledgement names the latest finished nightly close, so the kiosk
 * can tell a reply from before tonight's close from one after it.
 */
import { POST } from '@/app/api/scan/route';
import prisma from '@/lib/prisma';
import { authenticateRequest } from '@/lib/auth';
import { duringNightlyRun, lastNightlyCloseAt } from '@/lib/attendance/nightlyClose';
import { SCAN_PROTOCOL_VERSION } from '@/lib/scanProtocol';
import type { Person } from '@/generated/prisma/client';
import type { NextRequest } from 'next/server';

jest.mock('@/lib/auth', () => ({
    ...jest.requireActual('@/lib/auth'),
    authenticateRequest: jest.fn(),
}));
jest.mock('@/lib/notifications', () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
    sendNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/logger', () => ({
    logBackendError: jest.fn(),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const TAG = 'last-nightly-close-test';
const HOUR = 3_600_000;

describe('lastNightlyCloseAt (real DB)', () => {
    let member: Person;
    let scans = 0;

    const parkClosesAway = () => prisma.facilityClose.updateMany({ where: { via: 'NIGHTLY_SWEEP' }, data: { closedAt: new Date(0) } });
    const nightly = (closedAt: Date) => prisma.facilityClose.create({ data: { closedAt, via: 'NIGHTLY_SWEEP' } });
    const ack = async () => {
        scans += 1;
        const req = new Request('http://localhost/api/scan', {
            method: 'POST',
            body: JSON.stringify({ participantId: member.id, clientEventId: `${TAG}-${scans}`, intent: scans % 2 ? 'IN' : 'OUT', protocolVersion: SCAN_PROTOCOL_VERSION }),
        }) as unknown as NextRequest;
        return (await POST(req)).json();
    };

    beforeAll(async () => {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: 'kiosk' });
        member = await prisma.person.create({
            data: { name: 'Nightly Member', email: `${TAG}@example.com`, household: { create: { name: TAG } } },
        });
    });

    beforeEach(parkClosesAway);
    afterEach(parkClosesAway);

    afterAll(async () => {
        await prisma.visit.deleteMany({ where: { personId: member.id } });
        await prisma.presenceEvent.deleteMany({ where: { personId: member.id } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: member.id } });
        await prisma.person.delete({ where: { id: member.id } });
        await prisma.household.delete({ where: { id: member.householdId } });
    });

    it('before tonight\'s close, an acknowledgement names last night\'s', async () => {
        const lastNight = new Date(Date.now() - 24 * HOUR);
        await nightly(lastNight);
        expect((await ack()).lastNightlyCloseAt).toBe(lastNight.toISOString());
    });

    it('after tonight\'s close, an acknowledgement names it, and a keyholder\'s close never counts', async () => {
        await nightly(new Date(Date.now() - 24 * HOUR));
        const tonight = new Date(Date.now() - HOUR);
        await nightly(tonight);
        await prisma.facilityClose.create({ data: { closedAt: new Date(Date.now() - 60_000), via: 'KIOSK' } });
        expect((await ack()).lastNightlyCloseAt).toBe(tonight.toISOString());
    });

    it('a close recorded by a run still going is not reported until the run ends', async () => {
        const lastNight = new Date(Date.now() - 24 * HOUR);
        await nightly(lastNight);
        await duringNightlyRun(async () => {
            await nightly(new Date());
            expect(await lastNightlyCloseAt()).toBe(lastNight.toISOString());
        });
        expect(await lastNightlyCloseAt()).not.toBe(lastNight.toISOString());
    });

    it('a run that throws stops holding the close back', async () => {
        const recorded = new Date();
        await expect(duringNightlyRun(async () => {
            await nightly(recorded);
            throw new Error('boom');
        })).rejects.toThrow('boom');
        expect(await lastNightlyCloseAt()).toBe(recorded.toISOString());
    });
});
