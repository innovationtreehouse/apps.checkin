import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { createClaimantProduct, createShopifySingleVariantProgram } from "@/lib/shopify";
import { isProgramCheckoutBroken } from "@/lib/programCheckout";
import { logBackendError } from "@/lib/logger";
import { apiError } from "@/lib/api-response";

// Board repair/backfill: mints whichever of the program's two Shopify products is
// missing — the public variant (a program priced after create, since PATCH never
// mints variants) and the hidden claimant "reserved seat" product (programs made
// before it existed). Idempotent: a fully configured or free program is a 400.
// Mirrors the creation calls so the local mock branch (config.shopifyMockActive) works too.
export const POST = withAuth({ roles: ['isSysadmin', 'isBoardMember'] }, async (_req, auth, ctx: { params: Promise<{ id: string }> }) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);
    const { id } = await ctx.params;
    const programId = parseInt(id, 10);
    if (isNaN(programId)) return apiError("Invalid program ID", 400);

    const program = await prisma.program.findUnique({ where: { id: programId } });
    if (!program) return apiError("Program not found", 404);

    const basePriceCents = program.nonOrgMemberPriceCents ?? program.orgMemberPriceCents ?? null;
    const needsPublic = isProgramCheckoutBroken(program);
    const needsClaimant = !!basePriceCents && basePriceCents > 0 && !program.claimantShopifyVariantId;
    if (!needsPublic && !needsClaimant) {
        return apiError("Program checkout is already configured (or the program is free).", 400);
    }

    try {
        const publicData = needsPublic && basePriceCents
            ? await createShopifySingleVariantProgram(program.name, basePriceCents, program.maxParticipants)
            : null;
        if (needsPublic && !publicData) {
            return apiError("Shopify sync failed or is not configured. Check Shopify credentials.", 502);
        }
        const claimantData = needsClaimant ? await createClaimantProduct(program.name, basePriceCents) : null;
        if (!publicData && !claimantData) {
            return apiError("Shopify reserved-seat product creation failed or is not configured. Check Shopify credentials.", 502);
        }
        const updateData = { ...publicData, ...claimantData };

        const updated = await prisma.program.update({
            where: { id: programId },
            data: updateData,
        });

        await prisma.auditLog.create({
            data: {
                actorId: auth.user.id,
                action: 'EDIT',
                tableName: 'Program',
                affectedEntityId: updated.id,
                oldData: program,
                newData: updated,
            },
        });

        const warning = needsClaimant && !claimantData
            ? "Public product created, but the reserved-seat product failed; checkout uses the public variant until you retry."
            : undefined;
        return NextResponse.json({ success: true, program: updated, ...(warning && { warning }) });
    } catch (error) {
        await logBackendError(error, "POST /api/programs/[id]/sync-shopify");
        return apiError("Failed to sync program to Shopify", 500);
    }
});
