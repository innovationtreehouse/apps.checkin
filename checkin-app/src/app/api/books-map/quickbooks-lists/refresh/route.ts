import { ApiResponseError, handler } from "@/security/handler";
import { quickBooksListsStatus, refreshQuickBooksLists } from "@/lib/finance/quickBooksLists";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const MIN_REFRESH_GAP_MS = 30_000;

export const POST = handler("POST /api/books-map/quickbooks-lists/refresh", async ({ auth }) => {
    logger.info(`[quickbooks-lists] refresh requested by ${auth.type === "session" ? `person ${auth.user.id}` : auth.type}`);
    const current = await quickBooksListsStatus();
    // A press within 30 s of the last refresh answers with that copy instead of reading QuickBooks again.
    if (current.length > 0 && current.every((r) => Date.now() - r.refreshedAt.getTime() < MIN_REFRESH_GAP_MS)) {
        return { QuickBooksListsStatus: current };
    }
    let refreshed: Awaited<ReturnType<typeof refreshQuickBooksLists>>;
    try {
        refreshed = await refreshQuickBooksLists();
    } catch (err) {
        logger.error("[quickbooks-lists] refresh failed:", err);
        throw new ApiResponseError(503, "QuickBooks did not return its lists. Try again shortly.");
    }
    if (!refreshed) throw new ApiResponseError(503, "QuickBooks is not connected.");
    return { QuickBooksListsStatus: await quickBooksListsStatus() };
});
