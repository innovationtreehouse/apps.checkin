import { personActor, recordAudit } from "@/lib/auditActor";
import prisma from "@/lib/prisma";
import { settleApplicationsAwaitingCheck } from "@/lib/membership/settleHouseholdBg";
import { handler, unauthorized } from "@/security/handler";

export const dynamic = "force-dynamic";

/**
 * POST /api/membership-ops/applications/settle-waiting — the Board settles every household
 * whose open application is waiting on its background check, once. A household whose settle
 * fails becomes a stuck item on System Status. Writes one audit row naming who ran it and the
 * counts, and answers `{ households, opened, failed }`.
 */
export const POST = handler("POST /api/membership-ops/applications/settle-waiting", async ({ auth }) => {
    if (auth.type !== "session") throw unauthorized();
    const counts = await settleApplicationsAwaitingCheck("a Board fix-pending-checks click");
    const actor = personActor(auth.user.id);
    await prisma.$transaction((tx) =>
        recordAudit(tx, actor, { action: "EDIT", tableName: "APPLICATION_SETTLE_SWEEP", affectedEntityId: 0, newData: counts }),
    );
    return { ApplicationSettleCounts: counts };
});
