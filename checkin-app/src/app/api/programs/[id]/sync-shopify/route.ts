import crypto from "crypto";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { createClaimantProduct, createShopifySingleVariantProgram, programProductHandle, setProgramInventory, STOCK_BOOKKEEPING_RESET } from "@/lib/shopify";
import { countStockTakenSeats } from "@/lib/program/capacity";
import { isProgramCheckoutBroken } from "@/lib/programCheckout";
import { logBackendError } from "@/lib/logger";
import { apiError } from "@/lib/api-response";

/** A sync claim this old belongs to a run that died; the next run may take it over. Well past the creation calls' 20s-per-request deadlines. */
const SYNC_CLAIM_STALE_MS = 10 * 60_000;

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

    // One sync per program at a time, claimed on the row so no transaction stays open
    // across the Shopify calls. Products are created under a stable handle, so a run
    // that dies after Shopify created one hands it to the next run instead of a duplicate.
    const token = crypto.randomUUID();
    const now = new Date();
    const { count: claimed } = await prisma.program.updateMany({
        where: {
            id: programId,
            OR: [{ shopifySyncStartedAt: null }, { shopifySyncStartedAt: { lt: new Date(now.getTime() - SYNC_CLAIM_STALE_MS) } }],
        },
        data: { shopifySyncStartedAt: now, shopifySyncToken: token },
    });
    if (claimed !== 1) {
        const exists = await prisma.program.findUnique({ where: { id: programId }, select: { id: true } });
        return exists
            ? apiError("A Shopify sync for this program is already running.", 409)
            : apiError("Program not found", 404);
    }

    try {
        const program = await prisma.program.findUniqueOrThrow({ where: { id: programId } });

        const basePriceCents = program.nonOrgMemberPriceCents ?? program.orgMemberPriceCents ?? null;
        const needsPublic = isProgramCheckoutBroken(program);
        const needsClaimant = !!basePriceCents && basePriceCents > 0 && !program.claimantShopifyVariantId;
        if (!needsPublic && !needsClaimant) {
            return apiError("Program checkout is already configured (or the program is free).", 400);
        }

        const publicData = needsPublic && basePriceCents
            ? await createShopifySingleVariantProgram(program.name, basePriceCents, program.maxParticipants, programProductHandle(program, "public"))
            : null;
        if (needsPublic && !publicData) {
            return apiError("Shopify sync failed or is not configured. Check Shopify credentials.", 502);
        }
        const claimantData = needsClaimant
            ? await createClaimantProduct(program.name, basePriceCents, programProductHandle(program, "claimant"))
            : null;
        if (!publicData && !claimantData) {
            return apiError("Shopify reserved-seat product creation failed or is not configured. Check Shopify credentials.", 502);
        }

        const updated = await prisma.$transaction(async (tx) => {
            const { count } = await tx.program.updateMany({
                where: { id: programId, shopifySyncToken: token },
                // A new public variant starts its stock bookkeeping afresh.
                data: { ...publicData, ...claimantData, ...(publicData && STOCK_BOOKKEEPING_RESET), shopifySyncStartedAt: null, shopifySyncToken: null },
            });
            if (count !== 1) return null;
            const row = await tx.program.findUniqueOrThrow({ where: { id: programId } });
            await tx.auditLog.create({
                data: {
                    actorId: auth.user.id,
                    action: 'EDIT',
                    tableName: 'Program',
                    affectedEntityId: row.id,
                    oldData: program,
                    newData: row,
                },
            });
            return row;
        });
        // The claim went stale and another run took it; that run records the same products.
        if (!updated) return apiError("This Shopify sync was taken over by another run. Reload to see its result.", 409);

        const publicCreated = !!publicData;
        const claimantFailed = needsClaimant && !claimantData;

        // After the sync's transaction commits: the stock writer updates this Program row itself.
        // A new capped variant starts sold out (0 available); lift it to capacity less the seats already taken.
        const max = updated.maxParticipants;
        const stockOk = !publicCreated || max === null
            || await setProgramInventory(updated, async () => max - await countStockTakenSeats(programId), "initial-stock");

        const warning = claimantFailed
            ? "Public product created, but the reserved-seat product failed; checkout uses the public variant until you retry."
            : !stockOk
                ? "Public product created, but setting its Shopify stock failed, so it may show as sold out. Check System Status > Link Status."
                : undefined;
        return NextResponse.json({ success: true, program: updated, ...(warning && { warning }) });
    } catch (error) {
        await logBackendError(error, "POST /api/programs/[id]/sync-shopify");
        return apiError("Failed to sync program to Shopify", 500);
    } finally {
        await prisma.program.updateMany({
            where: { id: programId, shopifySyncToken: token },
            data: { shopifySyncStartedAt: null, shopifySyncToken: null },
        }).catch((error) => logBackendError(error, "POST /api/programs/[id]/sync-shopify: release claim"));
    }
});
