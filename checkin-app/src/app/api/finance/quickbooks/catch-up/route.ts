import { badRequest, handler, unauthorized } from "@/security/handler";
import { catchUpPosting, isPostingLane, postingCatchUpState, type PostingLane } from "@/lib/finance/quickBooksPosting";

export const dynamic = "force-dynamic";

function laneOf(value: unknown): PostingLane {
    if (!isPostingLane(value)) throw badRequest(`Unknown QuickBooks posting lane "${String(value)}"`);
    return value;
}

export const GET = handler("GET /api/finance/quickbooks/catch-up", async ({ req }) => ({
    QuickBooksPostingCatchUp: await postingCatchUpState(laneOf(req.nextUrl.searchParams.get("lane"))),
}));

export const POST = handler("POST /api/finance/quickbooks/catch-up", async ({ req, auth }) => {
    if (auth.type !== "session") throw unauthorized();
    const body: unknown = await req.json().catch(() => null);
    const lane = laneOf(body && typeof body === "object" && "lane" in body ? body.lane : undefined);
    return { QuickBooksPostingCatchUp: await catchUpPosting(lane, auth.user.id) };
});
