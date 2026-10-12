import { handler } from "@/security/handler";
import { listProgramOptions } from "@/lib/finance/budgetOwners";

export const dynamic = "force-dynamic";

export const GET = handler("GET /api/budget-owners/program-options", async () => ({
    Program: await listProgramOptions(),
}));
