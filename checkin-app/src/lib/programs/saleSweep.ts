import prisma from "@/lib/prisma";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { emailBoardMembers } from "@/lib/emailRecipients";
import { orgCalendarDay } from "@/lib/time";
import { reportShopifyFailure } from "@/lib/shopify/client";
import { setProgramProductOffSale } from "@/lib/shopify/stock";

// A week, less half a day so the daily run's start-time jitter can't push it to day 8.
const NOTIFY_AFTER_MS = 6.5 * 24 * 60 * 60 * 1000;

/** Programs whose effective off-sale date (offSaleAt, else startAt) is on or before `at`. */
const offSaleOnOrBefore = (at: Date) => ({
    OR: [{ offSaleAt: { lte: at } }, { offSaleAt: null, startAt: { lte: at } }],
});

/**
 * Ends every sale whose off-sale date has arrived: closes enrollment and stamps
 * saleEndedAt, which stops the restock +1. Only ever reduces visibility.
 * A program without a hidden reserved-seat product, which is how families who
 * claimed in time pay, keeps its public product; the admins are alerted once.
 */
async function endDueSales(now: Date): Promise<number> {
    const due = await prisma.program.findMany({
        where: { saleEndedAt: null, phase: { not: "FINISHED" }, ...offSaleOnOrBefore(orgCalendarDay(now)) },
        select: { id: true, name: true, shopifyProductId: true, claimantShopifyVariantId: true },
    });
    let ended = 0;
    for (const program of due) {
        const { count } = await prisma.program.updateMany({
            where: { id: program.id, saleEndedAt: null },
            data: { enrollmentStatus: "CLOSED", saleEndedAt: now },
        });
        if (count === 0) continue;
        ended++;
        if (program.shopifyProductId && !program.claimantShopifyVariantId) {
            await reportShopifyFailure(
                "saleSweep.noClaimantProduct",
                new Error(`Program ${program.id} has no reserved-seat product`),
                { programId: program.id, shopifyProductId: program.shopifyProductId },
                `The sale for ${program.name} has ended, but its public store product was left on sale because the program has no reserved-seat product for families who already claimed a place. Create one with Sync to Shopify on the program page, then take the public product off sale in Shopify by hand.`,
            );
        }
    }
    return ended;
}

/**
 * Hides the public store product of every ended sale that has a reserved-seat
 * product and is not hidden yet. productHiddenAt is stamped only after Shopify
 * confirms, so a failed hide (already alerted) is retried on the next run.
 * A re-arm never re-lists the product.
 */
async function hideEndedProducts(now: Date): Promise<number> {
    const owed = await prisma.program.findMany({
        where: { saleEndedAt: { not: null }, productHiddenAt: null, phase: { not: "FINISHED" }, shopifyProductId: { not: null }, claimantShopifyVariantId: { not: null } },
        select: { id: true, shopifyProductId: true },
    });
    let hidden = 0;
    for (const program of owed) {
        if (!(await setProgramProductOffSale(program))) continue;
        const { count } = await prisma.program.updateMany({
            where: { id: program.id, productHiddenAt: null },
            data: { productHiddenAt: now },
        });
        hidden += count;
    }
    return hidden;
}

/**
 * One week after a sale ends (saleEndedAt is stamped on the off-sale date's
 * daily run), emails the board the claims still unpaid — once
 * per program. The conditional claim on unpaidClaimsNotifiedAt makes a
 * concurrent or repeated run a no-op. The claim is released when no Board
 * member's send was accepted, so the next run retries; one accepted send
 * counts as told, because a retry would mail the others again every day.
 */
async function notifyUnpaidClaims(now: Date): Promise<number> {
    const weekAgo = new Date(now.getTime() - NOTIFY_AFTER_MS);
    const due = await prisma.program.findMany({
        where: { saleEndedAt: { lte: weekAgo }, unpaidClaimsNotifiedAt: null },
        select: {
            id: true,
            name: true,
            participants: {
                where: { status: "PENDING" },
                select: { person: { select: { name: true } } },
                orderBy: { pendingSince: "asc" },
            },
        },
    });
    let notified = 0;
    for (const program of due) {
        const { count } = await prisma.program.updateMany({
            where: { id: program.id, unpaidClaimsNotifiedAt: null },
            data: { unpaidClaimsNotifiedAt: now },
        });
        if (count === 0 || program.participants.length === 0) continue;
        const delivered = await emailBoardMembers("board.unpaidClaims", {
            programName: program.name,
            names: program.participants.map((p) => p.person.name ?? "Unnamed").join("\n"),
            actionLink: `${config.baseUrl()}/program-ops/programs/${program.id}`,
        }, "Unpaid-claims board ping failed:");
        if (delivered === 0) {
            await prisma.program.updateMany({
                where: { id: program.id, unpaidClaimsNotifiedAt: now },
                data: { unpaidClaimsNotifiedAt: null },
            });
            continue;
        }
        notified++;
    }
    return notified;
}

/** Daily program-sale sweep. Idempotent; never throws. */
export async function runSaleSweep(now: Date = new Date()): Promise<{ salesEnded: number; productsHidden: number; unpaidNotified: number } | { error: string }> {
    try {
        const salesEnded = await endDueSales(now);
        return { salesEnded, productsHidden: await hideEndedProducts(now), unpaidNotified: await notifyUnpaidClaims(now) };
    } catch (e) {
        logger.error("[sale-sweep] failed:", e);
        return { error: e instanceof Error ? e.message : String(e) };
    }
}
