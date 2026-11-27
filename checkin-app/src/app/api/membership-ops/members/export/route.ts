import { personActor, recordAudit } from "@/lib/auditActor";
import prisma from "@/lib/prisma";
import { listCurrentMembers, membersToCsv } from "@/lib/membership/currentMembers";
import { handler, unauthorized } from "@/security/handler";

export const dynamic = "force-dynamic";

/**
 * GET /api/membership-ops/members/export — the Board downloads every current member's
 * email as CSV text, answering `{ csv, count }`. One audit row names who ran it and how
 * many rows it held.
 */
export const GET = handler("GET /api/membership-ops/members/export", async ({ auth }) => {
    if (auth.type !== "session") throw unauthorized();
    const members = await listCurrentMembers();
    await prisma.$transaction((tx) =>
        recordAudit(tx, personActor(auth.user.id), {
            action: "EDIT",
            tableName: "MEMBERS_EXPORT",
            affectedEntityId: 0,
            newData: { count: members.length },
        }),
    );
    return { MembersExport: { csv: membersToCsv(members), count: members.length } };
});
