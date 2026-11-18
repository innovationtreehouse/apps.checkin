import { NextResponse } from "next/server";
import { withCron } from "@/lib/cronAuth";
import { logger } from "@/lib/logger";
import { runPersonBgAnnualSweep } from "@/lib/membership/personBgTriggers";

export const dynamic = "force-dynamic";

/**
 * GET /api/cron/person-bg-annual — open PERSON_BG obligations for program-attached
 * people ≥18 (as of the membership-year boundary) with no fresh check. Idempotent.
 * Authorized by `Authorization: Bearer $CRON_SECRET`.
 */
export const GET = withCron(async () => {
    const result = await runPersonBgAnnualSweep(new Date());
    logger.info("[CRON] person-bg annual sweep:", result);
    return NextResponse.json({ success: true, ...result });
});
