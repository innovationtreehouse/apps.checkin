import prisma from "@/lib/prisma";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { emailBoardMembers } from "@/lib/emailRecipients";
import { escapeHtml } from "@/lib/email-templates/base";
import { LIVE_PERSON } from "@/lib/person/filters";
import { orgCalendarDay } from "@/lib/time";
import { reportShopifyFailure, setProgramProductOffSale } from "@/lib/shopify";

// A week, less half a day so the daily run's start-time jitter can't push it to day 8.
const NOTIFY_AFTER_MS = 6.5 * 24 * 60 * 60 * 1000;

/** Programs whose effective off-sale date (offSaleAt, else startAt) is on or before `at`. */
const offSaleOnOrBefore = (at: Date) => ({
    OR: [{ offSaleAt: { lte: at } }, { offSaleAt: null, startAt: { lte: at } }],
});

/**
 * Ends every sale whose off-sale date has arrived: closes enrollment, stamps
 * saleEndedAt (which stops the restock +1) and hides the public store product.
 * Only ever reduces visibility; a re-arm never re-lists the product.
 *
 * The product is hidden only when the program has its hidden reserved-seat
 * product, which is how families who claimed in time pay. Without one the
 * public product stays up and the admins are alerted to create it.
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
        if (!program.shopifyProductId) continue;
        if (program.claimantShopifyVariantId) {
            // Never throws; a failure is logged and emailed by setProgramProductOffSale.
            await setProgramProductOffSale(program);
        } else {
            await reportShopifyFailure(
                "saleSweep.noClaimantProduct",
                new Error(`Program ${program.id} has no reserved-seat product`),
                { programId: program.id, shopifyProductId: program.shopifyProductId },
                `The sale for <strong>${escapeHtml(program.name)}</strong> has ended, but its public store product was left on sale because the program has no reserved-seat product for families who already claimed a place. Create one with Sync to Shopify on the program page, then take the public product off sale in Shopify by hand.`,
            );
        }
    }
    return ended;
}

/**
 * One week after a sale ends (saleEndedAt is stamped on the off-sale date's
 * daily run), emails the board the claims still unpaid — once
 * per program. The conditional claim on unpaidClaimsNotifiedAt makes a
 * concurrent or repeated run a no-op.
 */
async function notifyUnpaidClaims(now: Date): Promise<number> {
    const weekAgo = new Date(now.getTime() - NOTIFY_AFTER_MS);
    const due = await prisma.program.findMany({
        where: { saleEndedAt: { lte: weekAgo }, unpaidClaimsNotifiedAt: null },
        select: {
            id: true,
            name: true,
            participants: {
                where: { status: "PENDING", person: LIVE_PERSON },
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
        const names = program.participants
            .map((p) => `<li>${escapeHtml(p.person.name ?? "Unnamed")}</li>`)
            .join("");
        await emailBoardMembers(
            `Unpaid program claims: ${program.name}`,
            `<p>The sale for <strong>${escapeHtml(program.name)}</strong> ended a week ago. These claims are still unpaid:</p><ul>${names}</ul><p><a href="${config.baseUrl()}/program-ops/programs/${program.id}">Open the program</a></p>`,
            "Unpaid-claims board ping failed:",
        );
        notified++;
    }
    return notified;
}

/** Daily program-sale sweep. Idempotent; never throws. */
export async function runSaleSweep(now: Date = new Date()): Promise<{ salesEnded: number; unpaidNotified: number } | { error: string }> {
    try {
        return { salesEnded: await endDueSales(now), unpaidNotified: await notifyUnpaidClaims(now) };
    } catch (e) {
        logger.error("[sale-sweep] failed:", e);
        return { error: e instanceof Error ? e.message : String(e) };
    }
}
