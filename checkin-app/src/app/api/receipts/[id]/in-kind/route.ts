// Mounts a receipt route factory through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { routes } from "@checkin/receipt";
import { handler } from "@/security/handler";
import { receiptRoute } from "@/lib/receipt/route";
import { refuseOwnHouseholdDonor } from "@/lib/bulkDonation/donorSelfGuard";
import prisma from "@/lib/prisma";

export const PUT = handler("PUT /api/receipts/[id]/in-kind", (ctx) =>
  receiptRoute(routes.receipts.inKind((donor) => refuseOwnHouseholdDonor(prisma, ctx.auth, donor, "Receipt")))(ctx),
);
