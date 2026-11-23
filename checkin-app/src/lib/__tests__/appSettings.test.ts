/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * @jest-environment node
 */
import { APP_TIMEZONE } from '@/lib/time';

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { appSettings: { upsert: jest.fn() } },
}));

describe('resolveDisplayTimezone', () => {
    // The TTL cache is module state, so each case gets a fresh module — and with it
    // a fresh prisma mock, since resetModules re-runs the factory above.
    let resolveDisplayTimezone: () => Promise<string>;
    let upsert: jest.Mock;
    beforeEach(() => {
        jest.resetModules();
        upsert = require('@/lib/prisma').default.appSettings.upsert;
        resolveDisplayTimezone = require('@/lib/appSettings').resolveDisplayTimezone;
    });
    afterEach(() => jest.useRealTimers());

    it('resolves the org timezone from the settings row', async () => {
        upsert.mockResolvedValue({ timezone: 'Asia/Tokyo', locale: 'en-US' });
        await expect(resolveDisplayTimezone()).resolves.toBe('Asia/Tokyo');
    });

    it('reuses the resolved zone rather than querying per page render', async () => {
        upsert.mockResolvedValue({ timezone: 'Asia/Tokyo', locale: 'en-US' });
        await resolveDisplayTimezone();
        await resolveDisplayTimezone();
        expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('falls back to the last known zone when the database is unreachable', async () => {
        upsert.mockResolvedValueOnce({ timezone: 'Asia/Tokyo', locale: 'en-US' });
        await resolveDisplayTimezone();
        jest.useFakeTimers().setSystemTime(Date.now() + 120_000); // past the TTL
        upsert.mockRejectedValue(new Error('database is starting up'));
        await expect(resolveDisplayTimezone()).resolves.toBe('Asia/Tokyo');
    });

    it('falls back to APP_TIMEZONE when nothing has ever resolved', async () => {
        upsert.mockRejectedValue(new Error('database is starting up'));
        await expect(resolveDisplayTimezone()).resolves.toBe(APP_TIMEZONE);
    });
});

describe('orgToday', () => {
    let orgToday: (now?: Date) => Promise<Date>;
    let upsert: jest.Mock;
    beforeEach(() => {
        jest.resetModules();
        upsert = require('@/lib/prisma').default.appSettings.upsert;
        orgToday = require('@/lib/appSettings').orgToday;
    });

    // 11:30 PM on the 11th in Chicago, 12:30 AM on the 12th in New York.
    const instant = new Date('2026-10-12T04:30:00Z');

    it("takes today's day from the org's configured zone", async () => {
        upsert.mockResolvedValue({ timezone: 'America/New_York', locale: 'en-US' });
        expect((await orgToday(instant)).toISOString()).toBe('2026-10-12T00:00:00.000Z');
    });

    it('falls back to APP_TIMEZONE when the settings row cannot be read', async () => {
        upsert.mockRejectedValue(new Error('database is starting up'));
        expect((await orgToday(instant)).toISOString()).toBe('2026-10-11T00:00:00.000Z');
    });
});
