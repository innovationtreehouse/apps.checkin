import { logger } from "@/lib/logger";
import { ApiResponseError, handler } from "@/security/handler";
import { runMatchAudit, type MatchAuditResult } from "@/lib/finance/matchAudit";

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
export const GET = handler(
    "GET /api/finance-ops/s-read/match-audit",
    async () => {
        let result: MatchAuditResult;
        try {
            result = await runMatchAudit();
        } catch (error) {
            logger.error("Match audit failed:", error);
            throw new ApiResponseError(500, "Failed to run the match audit");
        }
        if (!result.configured) {
            throw new ApiResponseError(503, "The Shopify mirror is not wired in this environment");
        }
        return { MatchAuditReport: result };
    },
);
