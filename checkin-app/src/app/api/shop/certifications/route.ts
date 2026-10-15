import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { handler, forbidden, unauthorized } from "@/security/handler";
import { Prisma, ToolLevel, type ToolStatus } from '@/generated/prisma/client';
import prisma from "@/lib/prisma";
import { logBackendError } from "@/lib/logger";
import { apiError } from "@/lib/api-response";
import { LIVE_PERSON } from "@/lib/person/filters";
import { isActiveOrgMember } from "@/lib/orgMembership";
import { invalidateKioskCertificationsCache } from "@/lib/getKioskCertifications";
import { refuseSelfGrant, SELF_GRANT_REFUSAL_MESSAGE } from "@/lib/membership/selfGrantGuard";

const CERTIFIER_LEVEL = ToolLevel.MAY_CERTIFY_OTHERS;

/** Audit table for a refused change to a certifier's level, kept apart from ToolStatus edits. */
const CERTIFIER_CHANGE_REFUSAL_TABLE = "CertifierChangeRefusal";

type CertWrite = { kind: 'written'; cert: ToolStatus } | { kind: 'certifier' } | { kind: 'conflict' };

function isToolLevel(value: unknown): value is ToolLevel {
    return typeof value === 'string' && (Object.values(ToolLevel) as string[]).includes(value);
}

// Cert status is PUBLIC BY DESIGN — certifications are physically posted in the
// shop. This route runs on the @/security handler() runtime so that intent is
// DECLARED in the registry, not hand-rolled: admission is 'authenticated' (a
// logged-in member; denied households fail closed at authenticateRequest, which
// closes the old hand-rolled denied bypass), and the registry view — not this
// query — gates fields. We select only {id, name} (no client needs email), but
// the registry declares person email as staff-only (everyones:pii) so the
// stripper would gate it if ever added. That converts the endpoint from an
// IDOR-shaped hand-rolled select into declared policy, so the recurring audit
// false-positive resolves.
export const GET = handler('GET /api/shop/certifications', async ({ req, auth }) => {
    if (auth.type !== 'session') throw unauthorized(); // unreachable: admission gates non-sessions
    const user = auth.user;

    const { searchParams } = new URL(req.url);
    const personIdParam = searchParams.get('personId');
    const toolIdParam = searchParams.get('toolId');
    const allParam = searchParams.get('all');

    // "All Assignments" ops grid — certifiers/keyholders/admins only. NOT a
    // confidentiality boundary (the data is public-by-design); an ops-surface
    // gate preserving pre-migration behavior. Stays inline because the registry
    // authorize grammar can't express "holds a MAY_CERTIFY_OTHERS on any tool".
    if (allParam === 'true') {
        const hasCertifierAuth = (user.toolStatuses ?? []).some(ts => ts.level === 'MAY_CERTIFY_OTHERS');
        const isAuthorized = user.isSysadmin || user.isBoardMember || user.isKeyholder || hasCertifierAuth;
        if (!isAuthorized) throw forbidden();
        const certifications = await prisma.toolStatus.findMany({
            where: { person: LIVE_PERSON },
            orderBy: [{ tool: { name: 'asc' } }, { person: { name: 'asc' } }],
            include: {
                tool: true,
                person: { select: { id: true, name: true } },
            },
        });
        return { ToolStatus: certifications };
    }

    const targetUserId = personIdParam ? parseInt(personIdParam, 10) : user.id;
    const whereClause = toolIdParam
        ? { toolId: parseInt(toolIdParam, 10), person: LIVE_PERSON }
        : { personId: targetUserId };

    const certifications = await prisma.toolStatus.findMany({
        where: whereClause,
        include: {
            tool: true,
            person: toolIdParam ? { select: { id: true, name: true } } : false,
        },
    });

    return { ToolStatus: certifications };
});

// withAuth funnels the denied-household check at admission (closes GAP-1: this
// POST previously re-queried certifier status with no denied gate), then the
// certifier (MAY_CERTIFY_OTHERS) authorization runs as before.
export const POST = withAuth({}, async (req, auth) => {
    if (auth.type !== 'session') {
        return apiError("Unauthorized", 401);
    }
    const session = { user: auth.user };

    try {
        const body = await req.json();
        const { personId, toolId, level } = body;

        if (!personId || !toolId || !level) {
            return apiError("Missing required fields", 400);
        }

        if (!isToolLevel(level)) {
            return apiError("Invalid certification level", 400);
        }

        const currentUserId = session.user.id;
        const isSysAdminOrBoard = session.user?.isSysadmin || session.user?.isBoardMember;

        let hasCertifierPermission = isSysAdminOrBoard;

        if (!hasCertifierPermission) {
            // Check if user is a certifier for this specific tool
            const currentUserStatus = await prisma.toolStatus.findUnique({
                where: {
                    personId_toolId: {
                        personId: currentUserId,
                        toolId: parseInt(toolId, 10)
                    }
                }
            });

            if (currentUserStatus && currentUserStatus.level === "MAY_CERTIFY_OTHERS") {
                hasCertifierPermission = true;
            }
        }

        if (!hasCertifierPermission) {
            return apiError("Forbidden: You are not authorized to certify users on this tool", 403);
        }

        // Only sysadmins/board may promote a user to MAY_CERTIFY_OTHERS. A tool
        // certifier can change certification status up to (but not including)
        // MAY_CERTIFY_OTHERS — they cannot mint new certifiers.
        if (level === "MAY_CERTIFY_OTHERS" && !isSysAdminOrBoard) {
            return apiError("Forbidden: Only admins and board members can grant the Certifier level", 403);
        }

        const tId = parseInt(toolId, 10);
        const pId = parseInt(personId, 10);

        const target = await prisma.person.findUnique({ where: { id: pId }, select: { householdId: true } });
        if (await refuseSelfGrant(prisma, currentUserId, { personId: pId, householdId: target?.householdId ?? null }, {
            table: "ToolStatus",
            attempted: { toolId: tId, level },
        })) {
            return apiError(`Forbidden: ${SELF_GRANT_REFUSAL_MESSAGE}`, 403);
        }

        // Both actor and target must belong to an active member family.
        // Sysadmin/board are exempt from the actor check (system-level role).
        if (!isSysAdminOrBoard && !(await isActiveOrgMember(currentUserId))) {
            return apiError("Forbidden: certifier must belong to an active member family", 403);
        }
        if (!(await isActiveOrgMember(pId))) {
            return apiError("Forbidden: target must belong to an active member family", 403);
        }

        const outcome = await prisma.$transaction(async (tx): Promise<CertWrite> => {
            const currentStatus = await tx.toolStatus.findUnique({
                where: { personId_toolId: { personId: pId, toolId: tId } }
            });

            if (currentStatus?.level === CERTIFIER_LEVEL && !session.user.isBoardMember) {
                await tx.auditLog.create({
                    data: {
                        actorId: currentUserId,
                        action: 'EDIT',
                        tableName: CERTIFIER_CHANGE_REFUSAL_TABLE,
                        affectedEntityId: pId,
                        secondaryAffectedEntity: tId,
                        oldData: currentStatus,
                        newData: { reason: 'target_is_certifier', attempted: { level } },
                    }
                });
                return { kind: 'certifier' };
            }

            // Compare-and-set on the level read above, so a concurrent change
            // (e.g. the target being made a certifier) can't be overwritten.
            if (currentStatus) {
                const { count } = await tx.toolStatus.updateMany({
                    where: { personId: pId, toolId: tId, level: currentStatus.level },
                    data: { level },
                });
                if (count === 0) return { kind: 'conflict' };
            } else {
                const { count } = await tx.toolStatus.createMany({
                    data: { personId: pId, toolId: tId, level },
                    skipDuplicates: true,
                });
                if (count === 0) return { kind: 'conflict' };
            }
            const cert = await tx.toolStatus.findUniqueOrThrow({
                where: { personId_toolId: { personId: pId, toolId: tId } }
            });

            await tx.auditLog.create({
                data: {
                    actorId: currentUserId,
                    action: currentStatus ? 'EDIT' : 'CREATE',
                    tableName: 'ToolStatus',
                    affectedEntityId: pId,
                    secondaryAffectedEntity: tId,
                    oldData: currentStatus ?? Prisma.JsonNull,
                    newData: cert
                }
            });
            return { kind: 'written', cert };
        });

        if (outcome.kind === 'certifier') {
            return apiError("Forbidden: Only the Board can change the level of a certifier", 403);
        }
        if (outcome.kind === 'conflict') {
            return apiError("This certification changed while you were editing it. Reload and try again.", 409);
        }
        const upsertedCert = outcome.cert;

        invalidateKioskCertificationsCache();
        return NextResponse.json({ success: true, certification: upsertedCert });
    } catch (error: unknown) {
        await logBackendError(error, "POST /api/shop/certifications");
        return apiError("Failed to upsert certification", 500);
    }
});
