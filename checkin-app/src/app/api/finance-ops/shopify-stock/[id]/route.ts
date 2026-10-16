import { ApiResponseError, badRequest, handler, notFound, unauthorized } from "@/security/handler";
import { settleUnconfirmedStock, type UnconfirmedStockChoice } from "@/lib/shopify";

const CHOICES: readonly UnconfirmedStockChoice[] = ["landed", "notLanded"];

/**
 * POST /api/finance-ops/shopify-stock/[id] — the board settles a program's
 * unconfirmed Shopify stock change after checking Shopify by hand.
 * Body: { choice: "landed" | "notLanded", expected: <the amount the page showed> }.
 * A changed amount is refused (409) so a stale page can't settle the wrong number.
 */
export const POST = handler<{ id: string }>("POST /api/finance-ops/shopify-stock/[id]", async ({ req, auth, params }) => {
    if (auth.type !== "session") throw unauthorized();
    const programId = Number(params.id);
    if (!Number.isInteger(programId)) throw badRequest("Invalid program ID");

    const body: unknown = await req.json().catch(() => null);
    const { choice, expected } = (body && typeof body === "object" ? body : {}) as { choice?: unknown; expected?: unknown };
    if (!CHOICES.includes(choice as UnconfirmedStockChoice)) throw badRequest('choice must be "landed" or "notLanded"');
    if (typeof expected !== "number" || !Number.isInteger(expected) || expected === 0) throw badRequest("expected must be the non-zero unconfirmed amount shown");

    const outcome = await settleUnconfirmedStock(programId, expected, choice as UnconfirmedStockChoice, auth.user.id);
    if ("refused" in outcome) {
        if (outcome.refused === "notFound") throw notFound("Program not found");
        if (outcome.refused === "busy") throw new ApiResponseError(409, "A Shopify stock push for this program is running. Try again in a minute.");
        throw new ApiResponseError(409, "This program's unconfirmed amount changed since the page loaded. Reload and check Shopify again.");
    }
    return { UnconfirmedStockSettlement: { programId, choice, amount: expected, carry: outcome.carry } };
});
