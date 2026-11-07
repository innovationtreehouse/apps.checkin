import type { Prisma } from "@/generated/prisma/client";

/**
 * A live (non-tombstoned) Visit. A deleted visit keeps its row (deletedAt +
 * deletedById set) so the deletion is reviewable and reversible — so every
 * surface that lists, counts, or aggregates visits must filter through this.
 * Drift guard: src/__tests__/liveVisitDriftGuard.test.ts scans every
 * Visit-query site in src/app + src/lib and fails CI if a new one reads Visit
 * without this filter and isn't an explicitly justified exception.
 */
export const LIVE_VISIT: Prisma.VisitWhereInput = { deletedAt: null };

/**
 * A keyholder: the one person filter every "is a keyholder in the building"
 * question uses. The flag is read on every query, so a grant or revoke takes
 * effect on the next read: no visit is touched. Drift guard:
 * src/__tests__/keyholderFilterDriftGuard.test.ts.
 */
export const LIVE_KEYHOLDER: Prisma.PersonWhereInput = { isKeyholder: true };

/** An open, live visit by a keyholder: the building is open while one exists. */
export const KEYHOLDER_IN_BUILDING: Prisma.VisitWhereInput = { departedAt: null, ...LIVE_VISIT, person: LIVE_KEYHOLDER };
