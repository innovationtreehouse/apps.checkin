import prisma from "@/lib/prisma";
import { badRequest, handler, unauthorized } from "@/security/handler";

export const dynamic = "force-dynamic";

const SELECT = { qboProductionRealmId: true } as const;

/** GET /api/settings/quickbooks — the QuickBooks company prod may reach. Board only. */
export const GET = handler("GET /api/settings/quickbooks", async () => {
    const settings = await prisma.boardSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {}, select: SELECT });
    return { BoardSettings: settings };
});

/**
 * PUT /api/settings/quickbooks — body `{ qboProductionRealmId: string | null }`. A numeric
 * QuickBooks company id, or blank/null to turn QuickBooks off in prod. Every change writes an
 * audit row with the old and new value.
 */
export const PUT = handler("PUT /api/settings/quickbooks", async ({ req, auth }) => {
    if (auth.type !== "session") throw unauthorized();
    const body: unknown = await req.json().catch(() => {
        throw badRequest("Invalid JSON");
    });
    const raw = (body as { qboProductionRealmId?: unknown } | null)?.qboProductionRealmId;
    if (raw !== null && typeof raw !== "string") throw badRequest("qboProductionRealmId must be a string or null");
    const realmId = raw?.trim() || null;
    if (realmId !== null && !/^\d{1,30}$/.test(realmId)) throw badRequest("qboProductionRealmId must be a numeric QuickBooks company id");

    const settings = await prisma.$transaction(async (tx) => {
        const before = await tx.boardSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {}, select: SELECT });
        const after = await tx.boardSettings.update({ where: { id: 1 }, data: { qboProductionRealmId: realmId }, select: SELECT });
        await tx.auditLog.create({
            data: {
                actorId: auth.user.id,
                action: "EDIT",
                tableName: "BoardSettings",
                affectedEntityId: 1,
                oldData: before,
                newData: after,
            },
        });
        return after;
    });
    return { BoardSettings: settings };
});
