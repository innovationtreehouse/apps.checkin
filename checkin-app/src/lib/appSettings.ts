import prisma from "@/lib/prisma";
import type { DbClient } from "@/lib/db-client";
import { APP_TIMEZONE, calendarDayIn } from "@/lib/time";

/** Default locale, mirrors the AppSettings.locale schema default. */
export const APP_LOCALE = "en-US";

/**
 * App-wide localization config (timezone + locale), read from the AppSettings
 * singleton. The row is created on first read with the schema defaults, so this
 * never returns null. ponytail: queried per call (event creation / trends are
 * low-frequency); add a TTL cache if a hot path ever reads it per-request.
 */
export async function getAppSettings(): Promise<{ timezone: string; locale: string }> {
    const s = await prisma.appSettings.upsert({
        where: { id: 1 },
        create: { id: 1, timezone: APP_TIMEZONE, locale: APP_LOCALE },
        update: {},
    });
    return { timezone: s.timezone, locale: s.locale };
}

/** How long a resolved zone is reused before the settings row is read again. */
const TIMEZONE_TTL_MS = 60_000;
let cachedTimezone: { value: string; at: number } | null = null;

/**
 * The organisation's display timezone, for the root layout — which reads it on every
 * page render, so it is cached briefly rather than querying per request. An edit on the
 * localization settings page therefore takes up to a minute (and a reload) to show.
 *
 * Falls back to the last known value, then to APP_TIMEZONE, when the settings row can't
 * be read: a sleeping or unreachable database renders the app in the default zone rather
 * than failing every page.
 *
 * Pass `db` from inside a transaction: on a cache miss the row is then read through that
 * client, never upserted, so the read takes no second connection and holds no lock on the
 * singleton. A warm cache answers without reading, whichever client is passed.
 */
export async function resolveDisplayTimezone(db?: DbClient): Promise<string> {
    if (cachedTimezone && Date.now() - cachedTimezone.at < TIMEZONE_TTL_MS) return cachedTimezone.value;
    try {
        const timezone = db
            ? (await db.appSettings.findUnique({ where: { id: 1 }, select: { timezone: true } }))?.timezone
            : (await getAppSettings()).timezone;
        if (!timezone) return cachedTimezone?.value ?? APP_TIMEZONE;
        cachedTimezone = { value: timezone, at: Date.now() };
        return timezone;
    } catch {
        return cachedTimezone?.value ?? APP_TIMEZONE;
    }
}

/**
 * Today's calendar day (UTC midnight, the `@db.Date` shape) in the organisation's configured
 * zone. Pass `db` when already inside a transaction (see {@link resolveDisplayTimezone}).
 */
export async function orgToday(now: Date = new Date(), db?: DbClient): Promise<Date> {
    return calendarDayIn(now, await resolveDisplayTimezone(db));
}
