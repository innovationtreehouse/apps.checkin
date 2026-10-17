import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { getConfigHealth } from "@/lib/configHealth";
import { getCronJobStatuses } from "@/lib/cronRuns";

export const dynamic = "force-dynamic";

/**
 * GET /api/system-status/config-health — the "is the infrastructure wired and alive"
 * payload for the System Status page. Admins + board only; returns booleans, timestamps
 * and human detail, never secret values.
 *
 * Two halves, both feeding the same red nav badge via /api/nav/todo-counts (which reads
 * only the counts; this is the detail view):
 *   - `checks`   — static env/config presence (lib/configHealth.ts).
 *   - `cronJobs` — last successful run per cron sweep (lib/cronRuns.ts). Rides on this
 *                  route rather than its own: same page, same gate, same question, and a
 *                  new registered route would need its registry entry landed separately.
 */
export const GET = withAuth({}, async (_req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    if (!(auth.user.isSysadmin || auth.user.isBoardMember)) return apiError("Forbidden", 403);
    return NextResponse.json({ checks: getConfigHealth(), cronJobs: await getCronJobStatuses() });
});
