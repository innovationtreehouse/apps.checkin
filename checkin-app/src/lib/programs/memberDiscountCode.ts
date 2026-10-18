import prisma from "@/lib/prisma";
import { isMembershipFeeSettledThrough, programCoverageDate } from "@/lib/orgMembership";
import { LIVE_PERSON } from "@/lib/person/filters";

/**
 * Canonical prefix of a program's minted member-discount code. Single home for the
 * format: the minter (mintMemberDiscountCode in lib/shopify.ts) builds codes with it
 * and the entitlement check below matches on it, so the encoder and decoder cannot
 * drift. A minted code is `PRG{programId}-H{householdId}-XXXXXXXX`, always uppercase:
 * the household it was minted for is part of the code.
 */
export function programMemberCodePrefix(programId: number): string {
    return `PRG${programId}-`;
}

export function householdMemberCodePrefix(programId: number, householdId: number): string {
    return `${programMemberCodePrefix(programId)}H${householdId}-`;
}

/**
 * Does this order's coupon list carry THIS program's minted member code? Shopify
 * codes are case-insensitive, so the compare upper-cases and trims the order's side.
 * Prefix-matched on the program's OWN id (the trailing hyphen keeps PRG4 out of
 * PRG42). An EMPTY list is never evidence — pre-#1048 mirror rows carry none.
 */
export function usesProgramMemberCode(discountCodes: string[], programId: number): boolean {
    const prefix = programMemberCodePrefix(programId);
    return discountCodes.some((c) => c.trim().toUpperCase().startsWith(prefix));
}

/**
 * The household a program member code on this order was minted for: a number, or
 * null for a code that names none (minted before codes were household-bound).
 */
export function memberCodeHousehold(discountCodes: string[], programId: number): number | null {
    const bound = new RegExp(`^${programMemberCodePrefix(programId)}H(\\d+)-`);
    for (const c of discountCodes) {
        const m = c.trim().toUpperCase().match(bound);
        if (m) return parseInt(m[1], 10);
    }
    return null;
}

/**
 * Member-code entitlement, judged AT THE MONEY EVENT: true iff the paid order carries
 * this program's minted member code and the household the code was minted for does
 * not cover every enrollee, or is not fee-settled through the program's coverage
 * date. A code minted before codes named a household falls back to "some enrollee's
 * household is settled". Callers (the orders/paid webhook, and the reconciler's
 * forward pass recovering a missed one) flag DISCOUNT_UNAUTHORIZED and do not activate.
 *
 * `personIds` may come straight off the customer-controlled CheckMeIn_Account_ID cart
 * attribute, so it is intersected with this program's real ProgramParticipant rows
 * FIRST: otherwise stuffing any fee-settled person's id into the permalink buys the
 * member price for an unentitled enrollee. Believe the DB about who is enrolled.
 * The intersect keeps only rows THIS order is paying for — PENDING, or already
 * stamped with this same shopifyOrderId (a webhook redelivery must recognize its own
 * rows and stay quiet) — so a co-enrollee activated by some OTHER order cannot lend
 * their household's membership fee to this checkout.
 *
 * Asked once, when the money moves, and never re-derived afterwards — an ordinary
 * deactivation must not retro-flag orders that were honest when they were paid. The
 * PaymentException row is the durable judgement. Inherits isMembershipFeeSettledThrough's
 * fail-open when no membership-year boundary is configured.
 *
 * ACCEPTED WINDOW (named, not engineered away): a minted code lives 48h, so
 * entitlement can move between mint and checkout. We judge at
 * checkout, so a code minted while entitled but redeemed after the household lapses
 * is flagged at redemption — the intended answer, not a gap to close.
 */
export async function unentitledMemberCodeUse(
    programId: number,
    personIds: number[],
    discountCodes: string[],
    shopifyOrderId: string | null,
): Promise<boolean> {
    if (!usesProgramMemberCode(discountCodes, programId)) return false;
    // Only rows THIS order pays for carry entitlement: PENDING (about to be activated
    // by it) or already stamped with this order id (redelivery). An id enrolled-ACTIVE
    // via some OTHER order clears neither arm, so it cannot lend its household's membership fee.
    // LIVE_PERSON: a merge leaves the tombstone's enrollment row behind, and a
    // tombstone must not lend its old household's membership fee to someone else's checkout.
    const enrolled = await prisma.programParticipant.findMany({
        where: {
            programId,
            personId: { in: personIds },
            person: LIVE_PERSON,
            OR: [{ status: "PENDING" }, ...(shopifyOrderId ? [{ shopifyOrderId }] : [])],
        },
        select: { personId: true, person: { select: { householdId: true } } },
    });
    const program = await prisma.program.findUnique({ where: { id: programId }, select: { startAt: true, endAt: true, appliesToYear: true } });
    if (!program) return true;
    const through = await programCoverageDate(program);
    const boundHousehold = memberCodeHousehold(discountCodes, programId);
    if (boundHousehold !== null) {
        const [first] = enrolled;
        if (!first || enrolled.some((e) => e.person.householdId !== boundHousehold)) return true;
        return !(await isMembershipFeeSettledThrough(first.personId, through));
    }
    // ponytail: per-person loop, not a batched query — one order enrols one household.
    for (const { personId } of enrolled) {
        if (await isMembershipFeeSettledThrough(personId, through)) return false;
    }
    return true;
}
