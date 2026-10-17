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
