/**
 * @jest-environment node
 */
import { recordKioskProtocolSeen } from '@/lib/kioskProtocolSeen';
import prisma from '@/lib/prisma';

const TAG = 'kps-int-test';

describe('recordKioskProtocolSeen', () => {
    afterAll(async () => {
        await prisma.kioskProtocolSeen.deleteMany({ where: { keyFingerprint: { startsWith: TAG } } });
    });

    it('creates the row on first sight', async () => {
        const keyFingerprint = `${TAG}-new`;
        await recordKioskProtocolSeen(keyFingerprint, 6);
        const row = await prisma.kioskProtocolSeen.findUniqueOrThrow({ where: { keyFingerprint } });
        expect(row.protocolVersion).toBe(6);
    });

    it('raises the version when a newer one arrives', async () => {
        const keyFingerprint = `${TAG}-up`;
        await recordKioskProtocolSeen(keyFingerprint, 6);
        await recordKioskProtocolSeen(keyFingerprint, 7);
        const row = await prisma.kioskProtocolSeen.findUniqueOrThrow({ where: { keyFingerprint } });
        expect(row.protocolVersion).toBe(7);
    });

    it('keeps the newer version but bumps lastSeenAt when an older one arrives after it', async () => {
        const keyFingerprint = `${TAG}-down`;
        await recordKioskProtocolSeen(keyFingerprint, 7);
        const before = await prisma.kioskProtocolSeen.findUniqueOrThrow({ where: { keyFingerprint } });
        await new Promise((r) => setTimeout(r, 5));
        await recordKioskProtocolSeen(keyFingerprint, 5);
        const after = await prisma.kioskProtocolSeen.findUniqueOrThrow({ where: { keyFingerprint } });
        expect(after.protocolVersion).toBe(7);
        expect(after.lastSeenAt.getTime()).toBeGreaterThan(before.lastSeenAt.getTime());
    });
});
