import { NextResponse } from "next/server";
import { withCron } from "@/lib/cronAuth";
import { logger } from "@/lib/logger";
import { runPersonBgAnnualSweep } from "@/lib/membership/personBgTriggers";
import { settleApplicationsAwaitingCheck } from "@/lib/membership/settleHouseholdBg";

export const dynamic = "force-dynamic";

/**
 * GET /api/cron/person-bg-annual — open PERSON_BG obligations for program-attached
 * people ≥18 (as of the membership-year boundary) with no fresh check, then settle
 * every household application waiting on its check, which opens a check review for
 * one with consent and none open. Idempotent, so safe to run daily. Authorized by
 * `Authorization: Bearer $CRON_SECRET`.
 */
export const GET = withCron(async () => {
    const result = await runPersonBgAnnualSweep(new Date());
    logger.info("[CRON] person-bg annual sweep:", result);
    const settled = await settleApplicationsAwaitingCheck();
    logger.info("[CRON] household background-check settle:", settled);
    return NextResponse.json({ success: true, ...result, settled });
});
