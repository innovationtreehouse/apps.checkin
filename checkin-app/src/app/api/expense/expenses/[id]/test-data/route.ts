// Mounts the expense test-data toggle under checkin's handler(). It exists only on dev and local.
import { handler, notFound } from "@/security/handler";
import { config } from "@/lib/config";
import { componentRoute } from "@/lib/components/route";
import { routes } from "@checkin/expense";

const setTestData = componentRoute(routes.expenses.testData);

export const PUT = handler("PUT /api/expense/expenses/[id]/test-data", async (ctx) => {
  if (!config.isDevInstance()) throw notFound();
  return setTestData(ctx);
});
