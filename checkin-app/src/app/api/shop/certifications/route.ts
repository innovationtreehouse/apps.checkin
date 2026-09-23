import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { handler, forbidden, unauthorized } from "@/security/handler";
import { Prisma } from '@/generated/prisma/client';
import prisma from "@/lib/prisma";
import { logBackendError } from "@/lib/logger";
import { apiError } from "@/lib/api-response";
import { LIVE_PERSON } from "@/lib/person/filters";
import { isActiveOrgMember } from "@/lib/orgMembership";
import { invalidateKioskCertificationsCache } from "@/lib/getKioskCertifications";

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

        const validLevels = ["BASIC", "DOF", "CERTIFIED", "INSTRUCTOR", "MAY_CERTIFY_OTHERS"];
        if (!validLevels.includes(level)) {
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

        // Both actor and target must belong to an active member family.
        // Sysadmin/board are exempt from the actor check (system-level role).
        if (!isSysAdminOrBoard && !(await isActiveOrgMember(currentUserId))) {
            return apiError("Forbidden: certifier must belong to an active member family", 403);
        }
        if (!(await isActiveOrgMember(pId))) {
            return apiError("Forbidden: target must belong to an active member family", 403);
        }

        const currentStatus = await prisma.toolStatus.findUnique({
            where: { personId_toolId: { personId: pId, toolId: tId } }
        });

        const upsertedCert = await prisma.toolStatus.upsert({
            where: {
                personId_toolId: {
                    personId: pId,
                    toolId: tId
                }
            },
            update: {
                level: level as 'BASIC' | 'DOF' | 'CERTIFIED' | 'INSTRUCTOR' | 'MAY_CERTIFY_OTHERS'
            },
            create: {
                personId: pId,
                toolId: tId,
                level: level as 'BASIC' | 'DOF' | 'CERTIFIED' | 'INSTRUCTOR' | 'MAY_CERTIFY_OTHERS'
            }
        });

        await prisma.auditLog.create({
            data: {
                actorId: currentUserId,
                action: currentStatus ? 'EDIT' : 'CREATE',
                tableName: 'ToolStatus',
                affectedEntityId: pId,
                secondaryAffectedEntity: tId,
                oldData: currentStatus ?? Prisma.JsonNull,
                newData: upsertedCert
            }
        });

        invalidateKioskCertificationsCache();
        return NextResponse.json({ success: true, certification: upsertedCert });
    } catch (error: unknown) {
        await logBackendError(error, "POST /api/shop/certifications");
        return apiError("Failed to upsert certification", 500);
    }
});
