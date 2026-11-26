import { handler } from "@/security/handler";
import { membershipProductProblems } from "@/lib/membership/payment";

export const dynamic = "force-dynamic";

/**
 * GET /api/membership-ops/membership-products — each running membership year that an
 * unpaid application is for whose Shopify product can't be sold: missing, archived or
 * deleted, or unreadable because Shopify couldn't be reached. Drives the Board's error
 * chip on the applications and membership settings pages.
 */
export const GET = handler("GET /api/membership-ops/membership-products", async () => {
    return { MembershipProductProblem: await membershipProductProblems() };
});
