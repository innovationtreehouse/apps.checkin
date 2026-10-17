// Board + sysadmin telemetry viewer: returns a page of AuditLog rows for
// forensic review, newest first. Backs the "Audit Log" tab on /system-status.
// Server-side paged + filtered so the full history is reachable without ever
// shipping it all at once. The board is admitted because it answers for the
// decisions recorded here — a trail only a sysadmin can read cannot answer a
// family six months on (docs/rules/principles.md § Accountability).
import { NextResponse, type NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import type { Prisma } from "@/generated/prisma/client";
import { apiError } from "@/lib/api-response";

const PAGE_SIZE = 50;
const ACTIONS = ["CREATE", "EDIT", "DELETE", "BECOME_ADMIN"] as const;

export const GET = withAuth(
    { roles: ['isSysadmin', 'isBoardMember'] },
    async (req: NextRequest) => {
        try {
            const sp = new URL(req.url).searchParams;

            const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);

            const where: Prisma.AuditLogWhereInput = {};

            const action = sp.get("action");
            if (action && (ACTIONS as readonly string[]).includes(action)) {
                where.action = action as Prisma.AuditLogWhereInput["action"];
            }

            const table = sp.get("table");
            if (table) where.tableName = table;

            // One control, two columns: a person is selected by id, a system path by
            // its name (`cron:nightly`), which never parses as a number.
            const actor = sp.get("actor");
            if (actor) {
                const actorId = Number(actor);
                if (Number.isInteger(actorId) && actorId > 0) where.actorId = actorId;
                else where.actorSystem = actor;
            }

            // "Everything that touched #123" — the entity may sit in either slot
            // (a merge or an enrollment records the second id in secondary).
            const entityId = Number(sp.get("entityId"));
            if (Number.isInteger(entityId) && entityId > 0) {
                where.OR = [{ affectedEntityId: entityId }, { secondaryAffectedEntity: entityId }];
            }

            // from/to are yyyy-mm-dd. Inclusive day range, parsed in server TZ.
            // ponytail: server-local day boundaries; revisit if multi-TZ forensics matter.
            const from = sp.get("from");
            const to = sp.get("to");
            if (from || to) {
                where.timestamp = {};
                if (from) where.timestamp.gte = new Date(`${from}T00:00:00.000`);
                if (to) where.timestamp.lte = new Date(`${to}T23:59:59.999`);
            }

            const [total, rows, tableRows, actorIdRows, systemRows] = await Promise.all([
                prisma.auditLog.count({ where }),
                prisma.auditLog.findMany({
                    where,
                    orderBy: { timestamp: 'desc' },
                    skip: (page - 1) * PAGE_SIZE,
                    take: PAGE_SIZE,
                }),
                // Distinct entity types / actors for the filter dropdowns (unfiltered, stable).
                // groupBy, not findMany+distinct: Prisma's `distinct` dedups in the client,
                // so it drags every AuditLog row across the wire. groupBy emits SQL GROUP BY.
                // ponytail: still an index-only scan of the whole column; a loose index scan
                // (recursive CTE) is the next rung if the dropdowns ever get slow.
                prisma.auditLog.groupBy({
                    by: ['tableName'],
                    orderBy: { tableName: 'asc' },
                }),
                prisma.auditLog.groupBy({
                    by: ['actorId'],
                    where: { actorId: { gt: 0 } },
                }),
                prisma.auditLog.groupBy({
                    by: ['actorSystem'],
                    where: { actorSystem: { not: null } },
                    orderBy: { actorSystem: 'asc' },
                }),
            ]);

            // Resolve actor ids to names (one batched lookup) — for the rows on this
            // page and for the actor dropdown. A since-merged actor still names itself:
            // hiding them would falsify the history this log exists to preserve.
            const actorIds = [...new Set([...rows.map((r) => r.actorId), ...actorIdRows.map((a) => a.actorId)])];
            const actors = await prisma.person.findMany({
                where: { id: { in: actorIds } },
                select: { id: true, name: true },
            });
            const nameById = new Map(actors.map((a) => [a.id, a.name]));

            const logs = rows.map((r) => ({
                ...r,
                actorName: nameById.get(r.actorId) ?? null,
            }));

            return NextResponse.json({
                logs,
                total,
                page,
                pageSize: PAGE_SIZE,
                tables: tableRows.map((t) => t.tableName),
                actors: actorIdRows
                    .map((a) => ({ id: a.actorId, name: nameById.get(a.actorId) ?? `#${a.actorId}` }))
                    .sort((a, b) => a.name.localeCompare(b.name)),
                systemActors: systemRows.map((s) => s.actorSystem).filter((s): s is string => s !== null),
            });
        } catch (error) {
            logger.error("Failed to fetch audit logs:", error);
            return apiError("Failed to fetch audit logs", 500);
        }
    }
);
