import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { createClaimantProduct, createShopifySingleVariantProgram, setProgramInventory, STOCK_BOOKKEEPING_RESET } from "@/lib/shopify";
import { countStockTakenSeats } from "@/lib/program/capacity";
import { isProgramCheckoutBroken } from "@/lib/programCheckout";
import { logBackendError } from "@/lib/logger";
import { apiError } from "@/lib/api-response";

/** First key of the two-int advisory lock on a program's Shopify product creation. */
const SYNC_SHOPIFY_LOCK_CLASS = 7302;
/** Covers the creation calls' own 20s-per-request deadlines, several of them in sequence. */
const SYNC_SHOPIFY_TIMEOUT_MS = 180_000;

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

    try {
        // One sync per program at a time: the try-lock makes a concurrent second run a 409
        // instead of a second Shopify product, and the program is read only once it is held.
        // Shopify calls run inside the transaction, so its timeout covers their deadlines.
        const synced = await prisma.$transaction(async (tx) => {
            const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${SYNC_SHOPIFY_LOCK_CLASS}::int, ${programId}::int) AS locked`;
            if (!locked) return apiError("A Shopify sync for this program is already running.", 409);

            const program = await tx.program.findUnique({ where: { id: programId } });
            if (!program) return apiError("Program not found", 404);

            const basePriceCents = program.nonOrgMemberPriceCents ?? program.orgMemberPriceCents ?? null;
            const needsPublic = isProgramCheckoutBroken(program);
            const needsClaimant = !!basePriceCents && basePriceCents > 0 && !program.claimantShopifyVariantId;
            if (!needsPublic && !needsClaimant) {
                return apiError("Program checkout is already configured (or the program is free).", 400);
            }

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
            // A new public variant starts its stock bookkeeping afresh.
            const updateData = { ...publicData, ...claimantData, ...(publicData && STOCK_BOOKKEEPING_RESET) };

            const updated = await tx.program.update({
                where: { id: programId },
                data: updateData,
            });

            await tx.auditLog.create({
                data: {
                    actorId: auth.user.id,
                    action: 'EDIT',
                    tableName: 'Program',
                    affectedEntityId: updated.id,
                    oldData: program,
                    newData: updated,
                },
            });

            return { updated, publicCreated: !!publicData, claimantFailed: needsClaimant && !claimantData };
        }, { timeout: SYNC_SHOPIFY_TIMEOUT_MS });
        if (synced instanceof Response) return synced;
        const { updated, publicCreated, claimantFailed } = synced;

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
    }
});
