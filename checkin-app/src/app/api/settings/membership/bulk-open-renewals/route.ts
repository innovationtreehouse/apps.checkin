import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { runRenewalSweep } from "@/lib/membership/renewal";
import { apiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/**
 * POST /api/settings/membership/bulk-open-renewals — the board's yearly "start
 * renewals" button. Inside the renewal window, opens a renewal (PENDING_RENEWAL)
 * for every ACTIVE household not already handled this cycle — the same sweep and
 * skip test as runRenewalSweep, so a household that renewed or was granted the
 * coming year is never billed twice. Board members or sysadmins only. Never
 * emails; the settings/outreach page is the only send surface.
 */
export const POST = withAuth({ roles: ["isSysadmin", "isBoardMember"] }, async (_req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    const result = await runRenewalSweep(new Date());
    if ("reason" in result) return apiError(`Renewals can't be opened: ${result.reason}.`, 409);
    return NextResponse.json({ success: true, opened: result.opened, skipped: result.skipped });
});
