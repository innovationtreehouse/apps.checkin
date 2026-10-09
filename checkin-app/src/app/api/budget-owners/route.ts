import { handler, badRequest, unauthorized } from "@/security/handler";
import { createBudgetOwner, listBudgetOwners } from "@/lib/finance/budgetOwners";

export const dynamic = "force-dynamic";

export const GET = handler("GET /api/budget-owners", async ({ req }) => {
    const includeArchived = req.nextUrl.searchParams.get("includeArchived") === "1";
    return { BudgetOwner: await listBudgetOwners(includeArchived) };
});

export const POST = handler("POST /api/budget-owners", async ({ req, auth }) => {
    if (auth.type !== "session") throw unauthorized();
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") throw badRequest("Invalid JSON");
    return { BudgetOwner: await createBudgetOwner(auth.user.id, body) };
});
