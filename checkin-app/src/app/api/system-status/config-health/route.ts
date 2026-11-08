import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import prisma from "@/lib/prisma";
import { alertAddressCheck, getConfigHealth } from "@/lib/configHealth";
import { getCronJobStatuses } from "@/lib/cronRuns";
import { getActiveIncidents } from "@/lib/opsIncidentView";
import { getQuickBooksHealth } from "@/lib/quickbooks/health";
import { getReceiptMailboxHealth } from "@/lib/receipt/mailboxHealth";

export const dynamic = "force-dynamic";

/**
 * GET /api/system-status/config-health — the "is the infrastructure wired and alive"
 * payload for the System Status page. Admins + board only; returns booleans, timestamps
 * and human detail, never secret values.
 *
 * Two halves, both feeding the same red nav badge via /api/nav/todo-counts (which reads
 * only the counts; this is the detail view):
 *   - `checks`   — static env/config presence (lib/configHealth.ts), the alert address, then
 *                  the receipt mailbox and QuickBooks rows (lib/receipt/mailboxHealth.ts,
 *                  lib/quickbooks/health.ts), which read live and so stay off the badge.
 *   - `cronJobs` — last successful run per cron sweep (lib/cronRuns.ts). Rides on this
 *                  route rather than its own: same page, same gate, same question, and a
 *                  new registered route would need its registry entry landed separately.
 *   - `incidents` — incidents not yet closed (lib/opsIncidentView.ts), for the Open problems
 *                  panel. Rides here for the same reason.
 */
export const GET = withAuth({}, async (_req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    if (!(auth.user.isSysadmin || auth.user.isBoardMember)) return apiError("Forbidden", 403);
    const [settings, quickBooks, mailbox, cronJobs, incidents] = await Promise.all([
        prisma.boardSettings.findUnique({ where: { id: 1 }, select: { alertEmailAddress: true } }),
        getQuickBooksHealth(),
        getReceiptMailboxHealth(),
        getCronJobStatuses(),
        getActiveIncidents(),
    ]);
    return NextResponse.json({ checks: [...getConfigHealth(), alertAddressCheck(settings?.alertEmailAddress), ...mailbox, ...quickBooks], cronJobs, incidents });
});
