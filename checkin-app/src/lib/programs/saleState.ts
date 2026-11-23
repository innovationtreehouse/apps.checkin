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

/** True once the sale is over: the sweep has ended it, or its date is on or before
 *  `today`, the org's calendar day from `orgToday()` (the sweep runs once a day, so the
 *  date alone counts in the meantime). Only real dates count, so a row loaded without
 *  these fields reads as still on sale. */
export function isSaleEnded(p: Pick<SaleRow, 'startAt' | 'offSaleAt' | 'saleEndedAt'>, today: Date): boolean {
    if (p.saleEndedAt instanceof Date) return true;
    const offSale = effectiveOffSaleAt(p);
    return offSale instanceof Date && offSale <= today;
}

/** The public-stock change allowed for a program: after its sale has ended a
 *  change may only take stock away, never put a seat back on sale. */
export function saleStockDelta(p: Pick<SaleRow, 'startAt' | 'offSaleAt' | 'saleEndedAt'>, delta: number, today: Date): number {
    return isSaleEnded(p, today) ? Math.min(delta, 0) : delta;
}

export function classify(p: SaleRow, today: Date): SaleStateName {
    switch (p.phase) {
        case 'FINISHED':
            return 'FINISHED';
        case 'PLANNING':
        case 'UPCOMING':
        case 'RUNNING':
            if (isSaleEnded(p, today)) return 'SALE_ENDED';
            return p.enrollmentStatus === 'OPEN' ? 'ON_SALE' : 'NOT_ON_SALE';
        default:
            return assertNever(p.phase);
    }
}

export const TRANSITIONS: readonly Transition<SaleLifecycleState>[] = [
    { event: 'program created', from: '∅', to: 'NOT_ON_SALE', actor: 'board/lead', guardSite: 'api/programs POST' },
    { event: 'open enrollment', from: 'NOT_ON_SALE', to: 'ON_SALE', actor: 'board/lead', guardSite: 'api/programs/[id] PATCH enrollmentStatus' },
    { event: 'pause enrollment', from: 'ON_SALE', to: 'NOT_ON_SALE', actor: 'board/lead', guardSite: 'api/programs/[id] PATCH enrollmentStatus' },
    { event: 'off-sale date reached', from: 'ON_SALE', to: 'SALE_ENDED', actor: 'cron', guardSite: 'saleSweep.ts endDueSales — CAS saleEndedAt:null; close enrollment; hideEndedProducts hides the public product (retried until productHiddenAt) if a reserved-seat product exists, else alert' },
    { event: 'off-sale date reached', from: 'NOT_ON_SALE', to: 'SALE_ENDED', actor: 'cron', guardSite: 'saleSweep.ts endDueSales — CAS saleEndedAt:null; close enrollment; hideEndedProducts hides the public product (retried until productHiddenAt) if a reserved-seat product exists, else alert' },
    { event: 'board closes (off-sale date set to today)', from: 'ON_SALE', to: 'SALE_ENDED', actor: 'board', guardSite: 'api/programs/[id] PATCH offSaleAt' },
    { event: 'off-sale date moved later', from: 'SALE_ENDED', to: 'NOT_ON_SALE', actor: 'board', guardSite: 'api/programs/[id] PATCH offSaleAt — board only; clears the sweep markers, sets Shopify stock absolutely; never re-lists the product; enrollment stays closed' },
    { event: 'board reopens (date moved later + open)', from: 'SALE_ENDED', to: 'ON_SALE', actor: 'board', guardSite: 'api/programs/[id] PATCH offSaleAt + enrollmentStatus in one save; opening while ended without moving the date is refused (409)' },
    { event: 'program ends', from: 'SALE_ENDED', to: 'FINISHED', actor: 'board/lead', guardSite: 'api/programs/[id] PATCH phase — a lead only on or after the end date' },
    { event: 'cancelled', from: 'NOT_ON_SALE', to: 'FINISHED', actor: 'board/lead', guardSite: 'api/programs/[id] PATCH phase — a lead only on or after the end date' },
] as const;

export type EnrollmentClosedBy = 'FULL' | 'SALE_ENDED' | 'CLOSED';

/** Why the participants route would refuse any new claim, or null when it would take one.
 *  Full wins over an ended sale, which wins over enrollment closed by hand.
 *  An unknown count (undefined) never reads as full; the route still checks under lock. */
export function enrollmentClosedBy(
    p: Pick<SaleRow, 'enrollmentStatus' | 'startAt' | 'offSaleAt' | 'saleEndedAt'> & { maxParticipants: number | null },
    enrolledCount: number | undefined,
    today: Date,
): EnrollmentClosedBy | null {
    if (p.maxParticipants != null && enrolledCount != null && enrolledCount >= p.maxParticipants) return 'FULL';
    if (isSaleEnded(p, today)) return 'SALE_ENDED';
    if (p.enrollmentStatus === 'CLOSED') return 'CLOSED';
    return null;
}
