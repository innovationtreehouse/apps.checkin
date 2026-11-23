import prisma from "@/lib/prisma";
import { personActor, recordAudit } from "@/lib/auditActor";
import { runMatchAudit } from "@/lib/finance/matchAudit";
import { countStockTakenSeats } from "@/lib/program/capacity";
import { hideEndedProducts } from "@/lib/programs/saleSweep";
import { isSaleEnded } from "@/lib/programs/saleState";
import { isProgramStoreClosed } from "@/lib/programs/storeClosed";
import { setProgramInventory } from "@/lib/shopify/stock";
import { orgToday } from "@/lib/appSettings";

/** Why the Board's store switch did nothing. Each list names what a person must fix first. */
export type StoreSwitchRefusal =
    | { refused: "alreadyClosed" }
    | { refused: "notClosed" }
    | { refused: "noReservedSeatItem"; programs: string[] }
    | { refused: "hideUnconfirmed"; programs: string[] }
    | { refused: "auditUnavailable" }
    | { refused: "unclaimedOrders"; orders: string[] };

/** One program's stock write at a switch: `ok` is false when Shopify did not confirm it (the board was alerted). */
export interface ProgramStockResult {
    programId: number;
    name: string;
    ok: boolean;
}

/** Unfinished programs with a public store item: the items the closed store hides. */
const PUBLIC_ITEM = { phase: { not: "FINISHED" }, shopifyProductId: { not: null } } as const;

async function unhiddenPrograms(): Promise<string[]> {
    const rows = await prisma.program.findMany({
        where: { ...PUBLIC_ITEM, claimantShopifyVariantId: { not: null }, productHiddenAt: null },
        select: { name: true },
        orderBy: { id: "asc" },
    });
    return rows.map((p) => p.name);
}

async function setSwitch(actorId: number, closedAt: Date | null): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
        const { count } = await tx.boardSettings.updateMany({
            where: { id: 1, programStoreClosedAt: closedAt ? null : { not: null } },
            data: { programStoreClosedAt: closedAt },
        });
        if (count === 0) return false;
        await recordAudit(tx, personActor(actorId), {
            action: "EDIT",
            tableName: "BoardSettings",
            affectedEntityId: 1,
            newData: { programStoreClosedAt: closedAt?.toISOString() ?? null },
        });
        return true;
    });
}

/**
 * The Board closes the store to program seats. Refused while an unfinished
 * program with a public item has no reserved-seat item, since its families could
 * not pay. Sets the switch (audited), then sets each listed capped item's stock to
 * 0, one write per program under its row lock, then hides every public item. A
 * hide Shopify does not confirm is retried by the daily sweep.
 */
export async function closeProgramStore(actorId: number, now: Date = new Date()): Promise<StoreSwitchRefusal | { zeroed: ProgramStockResult[]; hidden: number; unhidden: string[] }> {
    const noReservedSeat = await prisma.program.findMany({
        where: { ...PUBLIC_ITEM, claimantShopifyVariantId: null },
        select: { name: true },
        orderBy: { id: "asc" },
    });
    if (noReservedSeat.length > 0) return { refused: "noReservedSeatItem", programs: noReservedSeat.map((p) => p.name) };
    if (!(await setSwitch(actorId, now))) return { refused: "alreadyClosed" };

    const listed = await prisma.program.findMany({
        where: { ...PUBLIC_ITEM, productHiddenAt: null, shopifyVariantId: { not: null }, maxParticipants: { not: null } },
        select: { id: true, name: true, shopifyVariantId: true },
        orderBy: { id: "asc" },
    });
    const zeroed: ProgramStockResult[] = [];
    for (const program of listed) {
        zeroed.push({ programId: program.id, name: program.name, ok: await setProgramInventory(program, async () => 0, "store-closed") });
    }
    const hidden = await hideEndedProducts(now);
    return { zeroed, hidden, unhidden: await unhiddenPrograms() };
}

/**
 * The Board reopens the store to program seats. Refused while any public item's
 * hide is unconfirmed (retried here first), or while the match audit lists a paid
 * program order nothing claims, because the re-count would put that buyer's seat
 * back on sale. Clears the switch (audited), then sets each open sale's stock to
 * capacity minus seats taken and clears its productHiddenAt, so the off-sale sweep
 * can hide the item again once a person re-lists it in Shopify.
 */
export async function openProgramStore(actorId: number, now: Date = new Date()): Promise<StoreSwitchRefusal | { recounted: ProgramStockResult[] }> {
    if (!(await isProgramStoreClosed())) return { refused: "notClosed" };
    await hideEndedProducts(now);
    const unhidden = await unhiddenPrograms();
    if (unhidden.length > 0) return { refused: "hideUnconfirmed", programs: unhidden };

    const audit = await runMatchAudit();
    if (!audit.configured || audit.configuredVariants === 0 || (audit.variantCoverage.lines > 0 && audit.variantCoverage.withVariant === 0)) {
        return { refused: "auditUnavailable" };
    }
    const unclaimed = audit.orders.filter((o) => o.bucket === "UNCLAIMED_PAID" && o.expected.some((e) => e.startsWith("program: ")));
    if (unclaimed.length > 0) return { refused: "unclaimedOrders", orders: unclaimed.map((o) => o.name ?? o.orderLegacyId ?? "unnamed order") };

    if (!(await setSwitch(actorId, null))) return { refused: "notClosed" };

    const programs = await prisma.program.findMany({
        where: PUBLIC_ITEM,
        select: { id: true, name: true, shopifyVariantId: true, maxParticipants: true, startAt: true, offSaleAt: true, saleEndedAt: true },
        orderBy: { id: "asc" },
    });
    const recounted: ProgramStockResult[] = [];
    const today = await orgToday(now);
    for (const program of programs.filter((p) => !isSaleEnded(p, today))) {
        const max = program.maxParticipants;
        const ok = max === null || await setProgramInventory(program, async (db) => max - await countStockTakenSeats(program.id, db), "store-reopened");
        // A re-count Shopify did not confirm leaves the item marked hidden and is reported, so nobody re-lists it on a wrong count.
        if (ok) await prisma.program.updateMany({ where: { id: program.id }, data: { productHiddenAt: null } });
        recounted.push({ programId: program.id, name: program.name, ok });
    }
    return { recounted };
}

/** What the Board sees when the switch is refused. */
export function storeSwitchRefusalMessage(r: StoreSwitchRefusal): string {
    switch (r.refused) {
        case "alreadyClosed": return "The store is already closed to program seats.";
        case "notClosed": return "The store is already open to program seats.";
        case "noReservedSeatItem": return `These programs have no reserved-seat item, so their families could not pay once the store closes. Run Sync to Shopify on each first: ${r.programs.join(", ")}.`;
        case "hideUnconfirmed": return `Shopify has not confirmed that these programs' store items are hidden. The daily run retries; try again once it has: ${r.programs.join(", ")}.`;
        case "auditUnavailable": return "The match audit can't run (the Shopify order mirror is not set up or not backfilled), so unclaimed store orders can't be ruled out.";
        case "unclaimedOrders": return `The match audit lists paid program orders nothing claims. Give each a place or a refund first: ${r.orders.join(", ")}.`;
    }
}
