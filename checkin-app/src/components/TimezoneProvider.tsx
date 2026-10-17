"use client";

import { createContext, useContext, useMemo } from 'react';
import {
    APP_TIMEZONE,
    formatDate,
    formatDateTime,
    formatTime,
    formatVisitRange,
    type DateInput,
} from '@/lib/time';

/**
 * Carries the organisation's configured display timezone (AppSettings.timezone) into
 * client components. The root layout (a server component) resolves it per request and
 * feeds it in here; leaf components read it via `useOrgTime()`.
 *
 * Context rather than module state: on the server one module instance is shared by every
 * concurrent request, so an installed value belongs to whichever request wrote it last.
 */
const TimezoneContext = createContext<string>(APP_TIMEZONE);

export function TimezoneProvider({ value, children }: { value: string; children: React.ReactNode }) {
    return <TimezoneContext.Provider value={value || APP_TIMEZONE}>{children}</TimezoneContext.Provider>;
}

/** The organisation's display timezone for this render tree. */
export function useDisplayTimezone(): string {
    return useContext(TimezoneContext);
}

type ZoneFreeOptions = Omit<Intl.DateTimeFormatOptions, 'timeZone'>;

/**
 * The instant formatters bound to this tree's configured zone — the client-side seam
 * for `lib/time`, whose raw formatters take the zone explicitly. Safe to call from
 * render bodies, memos and callbacks, since it returns plain functions.
 *
 * `timeZone` is omitted from the options: the tree's zone always wins, so accepting
 * one and discarding it would be the same silent-wrong-zone footgun this seam closes.
 */
export function useOrgTime() {
    const timeZone = useDisplayTimezone();
    return useMemo(
        () => ({
            formatDate: (date: DateInput, options?: ZoneFreeOptions) =>
                formatDate(date, { ...options, timeZone }),
            formatTime: (date: DateInput, options?: ZoneFreeOptions) =>
                formatTime(date, { ...options, timeZone }),
            formatDateTime: (date: DateInput, options?: ZoneFreeOptions) =>
                formatDateTime(date, { ...options, timeZone }),
            formatVisitRange: (arrived: DateInput, departed?: DateInput) =>
                formatVisitRange(arrived, departed, timeZone),
        }),
        [timeZone],
    );
}
