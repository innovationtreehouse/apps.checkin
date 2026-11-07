/**
 * @jest-environment node
 */
/**
 * OpsIncident against a real Postgres: the unique open key and its check
 * constraint allow one open incident per key and any number of closed ones.
 */
import prisma from '@/lib/prisma';

const KEY = 'ops-incident-int:connection:quickbooks';

const open = () => prisma.opsIncident.create({ data: { key: KEY, openKey: KEY, cause: 'quickbooks', kind: 'connection' } });

describe('OpsIncident (real DB)', () => {
    afterEach(async () => {
        await prisma.opsIncident.deleteMany({ where: { key: KEY } });
    });

    it('refuses a second open incident with the same key', async () => {
        await open();
        await expect(open()).rejects.toMatchObject({ code: 'P2002' });
    });

    it('allows a new open incident once the old one is closed', async () => {
        const first = await open();
        await prisma.opsIncident.update({ where: { id: first.id }, data: { openKey: null, closedAt: new Date() } });

        await expect(open()).resolves.toMatchObject({ openKey: KEY });
        expect(await prisma.opsIncident.count({ where: { key: KEY } })).toBe(2);
    });

    it('refuses an open key that differs from the key', async () => {
        await expect(
            prisma.opsIncident.create({ data: { key: KEY, openKey: `${KEY}-other`, cause: 'quickbooks', kind: 'connection' } }),
        ).rejects.toThrow();
    });

    it('refuses a closed incident that keeps its open key', async () => {
        const first = await open();
        await expect(prisma.opsIncident.update({ where: { id: first.id }, data: { closedAt: new Date() } })).rejects.toThrow();
    });
});
