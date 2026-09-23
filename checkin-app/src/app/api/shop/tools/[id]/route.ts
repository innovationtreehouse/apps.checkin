import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { logBackendError } from "@/lib/logger";
import { apiError } from "@/lib/api-response";
import { invalidateKioskCertificationsCache } from "@/lib/getKioskCertifications";

export const PATCH = withAuth(
    { roles: ['isSysadmin', 'isBoardMember'] },
    async (req, auth, { params }: { params: Promise<{ id: string }> }) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);

    const { id } = await params;
    const toolId = parseInt(id, 10);
    if (isNaN(toolId)) {
        return apiError("Invalid tool ID", 400);
    }

    try {
        const body = await req.json();
        const { name, safetyGuide } = body;

        const data: { name?: string; safetyGuide?: string | null } = {};
        if (name !== undefined) data.name = name;
        if (safetyGuide !== undefined) data.safetyGuide = safetyGuide || null;

        const tool = await prisma.tool.update({
            where: { id: toolId },
            data,
        });

        await prisma.auditLog.create({
            data: {
                actorId: auth.user.id,
                action: 'EDIT',
                tableName: 'Tool',
                affectedEntityId: toolId,
                newData: tool,
            },
        });

        invalidateKioskCertificationsCache();
        return NextResponse.json({ success: true, tool });
    } catch (error) {
        await logBackendError(error, "PATCH /api/shop/tools/[id]");
        return apiError("Failed to update tool", 500);
    }
});
