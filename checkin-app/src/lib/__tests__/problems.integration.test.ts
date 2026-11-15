/**
 * @jest-environment node
 */
import prisma from '@/lib/prisma';
import { getProblems, LIBRARY_DB_VARS } from '@/lib/problems';

const TAG = 'problems-integration-test';
const HOUR = 60 * 60 * 1000;
// A fixed past day, so email failures other suites log at the real time stay outside the window.
const NOW = new Date('2001-01-10T12:00:00Z');
const at = (hoursBefore: number) => new Date(NOW.getTime() - hoursBefore * HOUR);
// Every library database is unset here, so only email lines show.

describe('getProblems email failure line', () => {
    const saved = new Map<string, string | undefined>();

    beforeAll(() => {
        for (const name of LIBRARY_DB_VARS) {
            saved.set(name, process.env[name]);
            delete process.env[name];
        }
    });

    afterAll(() => {
        for (const [name, value] of saved) {
            if (value !== undefined) process.env[name] = value;
        }
    });

    afterEach(async () => {
        await prisma.integrationErrorLog.deleteMany({ where: { message: TAG } });
    });

    it('has no line while no email send failed in the day before now', async () => {
        await prisma.integrationErrorLog.create({ data: { source: 'email', message: TAG, timestamp: at(25) } });
        expect((await getProblems(NOW)).notices).toEqual([]);
    });

    it('counts only email failures in the day before now', async () => {
        await prisma.integrationErrorLog.createMany({
            data: [
                { source: 'email', message: TAG, timestamp: at(2), context: { to: 'j***@example.org', subject: 'Your receipt' } },
                { source: 'email', message: TAG, timestamp: at(23) },
                { source: 'email', message: TAG, timestamp: at(30) },
                { source: 'shopify', message: TAG, timestamp: at(1) },
            ],
        });

        const { notices } = await getProblems(NOW);

        expect(notices).toEqual([{ text: 'Emails failed to send: 2 in the last day', href: '/system-status/links' }]);
        expect(JSON.stringify(notices)).not.toMatch(/example\.org|Your receipt/);
    });
});
