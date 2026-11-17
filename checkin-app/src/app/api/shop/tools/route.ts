import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { logBackendError } from "@/lib/logger";
import { apiError } from "@/lib/api-response";
import { personActor, recordAudit } from "@/lib/auditActor";
import { invalidateKioskCertificationsCache } from "@/lib/getKioskCertifications";

export const GET = withAuth({}, async (_req, auth) => {
    // withAuth funnels the denied-household check (auth.ts) and rejects kiosk —
    // a raw getServerSession would let a board-denied member keep reading shop data.
    if (auth.type !== 'session') {
        return apiError("Unauthorized", 401);
    }

    try {
        const tools = await prisma.tool.findMany({
            orderBy: { name: 'asc' },
            // The columns the tool lists read; a column added later stays out until selected here.
            select: {
                id: true,
                name: true,
                safetyGuide: true,
                _count: { select: { toolStatuses: true } },
            },
        });

        return NextResponse.json(tools);
    } catch (error) {
        await logBackendError(error, "GET /api/shop/tools");
        return apiError("Failed to fetch tools", 500);
    }
});

export const POST = withAuth({}, async (req, auth) => {
    if (auth.type !== 'session') {
        return apiError("Unauthorized", 401);
    }
    const session = { user: auth.user };

    const isAuthorized = session.user?.isSysadmin || session.user?.isBoardMember;

    if (!isAuthorized) {
        return apiError("Forbidden: Only admins and board members can create tools", 403);
    }

    try {
        const body = await req.json();
        const { name, safetyGuide } = body;

        if (!name) {
            return apiError("Tool name is required", 400);
        }

        const newTool = await prisma.$transaction(async (tx) => {
            const tool = await tx.tool.create({
                data: {
                    name,
                    safetyGuide: safetyGuide || null
                }
            });
            await recordAudit(tx, personActor(session.user.id), {
                action: 'CREATE',
                tableName: 'Tool',
                affectedEntityId: tool.id,
                newData: tool
            });
            return tool;
        });

        invalidateKioskCertificationsCache();
        return NextResponse.json({ success: true, tool: newTool });
    } catch (error: unknown) {
        await logBackendError(error, "POST /api/shop/tools");
        return apiError("Failed to create tool", 500);
    }
});
