import { handler } from "@/security/handler";
import { listQuickBooksClasses } from "@/lib/finance/budgetOwners";

export const dynamic = "force-dynamic";

export const GET = handler("GET /api/budget-owners/quickbooks-classes", async () => ({
    QuickBooksClassOption: await listQuickBooksClasses(),
}));
