/**
 * A program's time on sale — the sale lifecycle, declared as data.
 *
 * NOT_ON_SALE → ON_SALE (board opens) → SALE_ENDED (off-sale date, or the board
 * sets that date to today) → FINISHED. Automatic steps only ever REDUCE
 * visibility: the daily sweep (saleSweep.ts) ends a sale; opening, reopening
 * and putting a program back on sale are always board actions.
 *
 * Client-safe: no Prisma value imports.
 */
import { assertNever, type Transition } from '@/lib/lifecycle';
import { orgCalendarDay } from '@/lib/time';

export type SaleStateName = 'NOT_ON_SALE' | 'ON_SALE' | 'SALE_ENDED' | 'FINISHED';
export type SaleLifecycleState = SaleStateName | '∅';

export type SaleRow = {
    phase: 'PLANNING' | 'UPCOMING' | 'RUNNING' | 'FINISHED';
    enrollmentStatus: 'OPEN' | 'CLOSED';
    startAt: Date;
    offSaleAt: Date | null;
    saleEndedAt: Date | null;
};

/** The off-sale date in effect: the board's date, else the start date. */
export function effectiveOffSaleAt(p: Pick<SaleRow, 'startAt' | 'offSaleAt'>): Date {
    return p.offSaleAt ?? p.startAt;
}

/** True once the sale is over: the sweep has ended it, or its date has arrived in
 *  the org's zone (the sweep runs once a day, so the date alone counts in the meantime). */
export function isSaleEnded(p: Pick<SaleRow, 'startAt' | 'offSaleAt' | 'saleEndedAt'>, now: Date = new Date()): boolean {
    return p.saleEndedAt !== null || effectiveOffSaleAt(p) <= orgCalendarDay(now);
}

export function classify(p: SaleRow, now: Date = new Date()): SaleStateName {
    switch (p.phase) {
        case 'FINISHED':
            return 'FINISHED';
        case 'PLANNING':
        case 'UPCOMING':
        case 'RUNNING':
            if (isSaleEnded(p, now)) return 'SALE_ENDED';
            return p.enrollmentStatus === 'OPEN' ? 'ON_SALE' : 'NOT_ON_SALE';
        default:
            return assertNever(p.phase);
    }
}

export const TRANSITIONS: readonly Transition<SaleLifecycleState>[] = [
    { event: 'program created', from: '∅', to: 'NOT_ON_SALE', actor: 'board/lead', guardSite: 'api/programs POST' },
    { event: 'open enrollment', from: 'NOT_ON_SALE', to: 'ON_SALE', actor: 'board/lead', guardSite: 'api/programs/[id] PATCH enrollmentStatus' },
    { event: 'pause enrollment', from: 'ON_SALE', to: 'NOT_ON_SALE', actor: 'board/lead', guardSite: 'api/programs/[id] PATCH enrollmentStatus' },
    { event: 'off-sale date reached', from: 'ON_SALE', to: 'SALE_ENDED', actor: 'cron', guardSite: 'saleSweep.ts endDueSales — close enrollment, stamp saleEndedAt; CAS saleEndedAt:null' },
    { event: 'off-sale date reached', from: 'NOT_ON_SALE', to: 'SALE_ENDED', actor: 'cron', guardSite: 'saleSweep.ts endDueSales — close enrollment, stamp saleEndedAt; CAS saleEndedAt:null' },
    { event: 'board closes (off-sale date set to today)', from: 'ON_SALE', to: 'SALE_ENDED', actor: 'board', guardSite: 'api/programs/[id] PATCH offSaleAt' },
    { event: 'off-sale date moved later', from: 'SALE_ENDED', to: 'NOT_ON_SALE', actor: 'board', guardSite: 'api/programs/[id] PATCH offSaleAt — clears the sweep markers; enrollment stays closed' },
    { event: 'program ends', from: 'SALE_ENDED', to: 'FINISHED', actor: 'board/lead', guardSite: 'api/programs/[id] PATCH phase' },
    { event: 'cancelled', from: 'NOT_ON_SALE', to: 'FINISHED', actor: 'board/lead', guardSite: 'api/programs/[id] PATCH phase' },
] as const;
