// Mounts the no-receipt in-kind factories under checkin's handler(). The
// endpoint strings MUST match their src/security/registry/donation.ts entries.
import { handler } from "@/security/handler";
import { componentRoute } from "@/lib/components/route";
import { refuseOwnHouseholdDonor } from "@/lib/bulkDonation/donorSelfGuard";
import prisma from "@/lib/prisma";
import { routes } from "@checkin/bulk-donation";

// Only these views carry donor `pii`; ops gets the list without donor fields selected.
const DONOR_VIEWS = new Set(["isFinance", "isBoardMember"]);

export const GET = handler("GET /api/donations/in-kind/manual", (ctx) =>
  componentRoute(routes.inKind.listManual(DONOR_VIEWS.has(ctx.role)))(ctx),
);

export const POST = handler("POST /api/donations/in-kind/manual", (ctx) =>
  componentRoute(routes.inKind.recordManual((donor) => refuseOwnHouseholdDonor(prisma, ctx.auth, donor, "ManualInKindDonation")))(ctx),
);
