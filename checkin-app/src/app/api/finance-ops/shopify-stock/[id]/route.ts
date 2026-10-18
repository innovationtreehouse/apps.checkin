import { ApiResponseError, badRequest, handler, notFound, unauthorized } from "@/security/handler";
import { settleUnconfirmedStock, type UnconfirmedStockChoice } from "@/lib/shopify";

const CHOICES: readonly UnconfirmedStockChoice[] = ["landed", "notLanded"];

/**
 * POST /api/finance-ops/shopify-stock/[id] — the board settles a program's
 * unconfirmed Shopify stock change after checking Shopify by hand.
 * Body: { choice: "landed" | "notLanded", expected: <the row's amount>, since: <the row's unconfirmedSince, or null> }.
 * A write no longer parked is refused (409) so a stale page can't settle a different write.
 */
export const POST = handler<{ id: string }>("POST /api/finance-ops/shopify-stock/[id]", async ({ req, auth, params }) => {
    if (auth.type !== "session") throw unauthorized();
    const programId = Number(params.id);
    if (!Number.isInteger(programId)) throw badRequest("Invalid program ID");

    const body: unknown = await req.json().catch(() => null);
    const { choice, expected, since } = (body && typeof body === "object" ? body : {}) as { choice?: unknown; expected?: unknown; since?: unknown };
    if (!CHOICES.includes(choice as UnconfirmedStockChoice)) throw badRequest('choice must be "landed" or "notLanded"');
    if (typeof expected !== "number" || !Number.isInteger(expected) || expected === 0) throw badRequest("expected must be the non-zero unconfirmed amount shown");
    if (since !== undefined && since !== null && typeof since !== "string") throw badRequest("since must be the row's unconfirmedSince or null");

    const outcome = await settleUnconfirmedStock(programId, expected, since ?? null, choice as UnconfirmedStockChoice, auth.user.id);
    if ("refused" in outcome) {
        if (outcome.refused === "notFound") throw notFound("Program not found");
        if (outcome.refused === "busy") throw new ApiResponseError(409, "A Shopify stock push for this program is running. Try again in a minute.");
        throw new ApiResponseError(409, "This unconfirmed change was settled or cleared since the page loaded. Reload and check Shopify again.");
    }
    return { UnconfirmedStockSettlement: { programId, choice, amount: expected, carry: outcome.carry } };
});
