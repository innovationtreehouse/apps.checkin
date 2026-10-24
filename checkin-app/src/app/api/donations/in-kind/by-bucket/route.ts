// Mounts the in-kind by-bucket factory under checkin's handler(). The endpoint
// string MUST match its src/security/registry/donation.ts entry.
import { handler } from "@/security/handler";
import { componentRoute } from "@/lib/components/route";
import { routes } from "@checkin/bulk-donation";

// Finance and the board see every bucket; a program approver sees only the buckets they approve.
const ALL_BUCKET_VIEWS = new Set(["isFinance", "isBoardMember"]);

export const GET = handler("GET /api/donations/in-kind/by-bucket", (ctx) =>
  componentRoute(routes.inKind.listByBucket(ALL_BUCKET_VIEWS.has(ctx.role)))(ctx),
);
