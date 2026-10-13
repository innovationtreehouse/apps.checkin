import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { runMatchAudit } from "@/lib/finance/matchAudit";

/**
 * GET /api/finance-ops/s-read/match-audit — the bidirectional Shopify ↔ activation
 * completeness report (lib/finance/matchAudit.ts): every mirror order carrying a
 * membership/program VARIANT accounted for, every ACTIVE membership/enrollment
 * traced to an order, a board certification, or flagged as having no payment basis.
 *
 * Read-only: reports, raises no PaymentExceptions, changes nothing. On-demand only
 * (a board click on the payments page) — it sweeps the whole mirror-relevant
 * surface, so it must never run on a poll or cron (scale-to-zero Aurora; the same
 * cost rule as the diagnose route).
 *
 * Same board gate + mirror-503 shape as the sibling s-read routes, so the
 * page can treat "not wired here" uniformly.
 */
export const GET = withAuth(
    { roles: ['isBoardMember'] },
    async (_req, auth) => {
        if (auth.type !== 'session') {
            return apiError("Unauthorized", 401);
        }

        try {
            const result = await runMatchAudit();
            if (!result.configured) {
                return apiError("The Shopify mirror is not wired in this environment", 503);
            }
            return NextResponse.json(result);
        } catch (error) {
            logger.error("Match audit failed:", error);
            return apiError("Failed to run the match audit", 500);
        }
    },
);
