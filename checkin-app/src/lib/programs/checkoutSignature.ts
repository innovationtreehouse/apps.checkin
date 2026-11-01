import crypto from "crypto";
import { config } from "@/lib/config";

/**
 * Signature a program checkout link carries in its CheckMeIn_Checkout_Sig cart
 * attribute: HMAC-SHA256 over the program, the people the link names and the
 * household they belong to. Only the server signs, and only for the signed-in
 * caller's own household, so a paid order with a valid signature proves the people
 * it names were put in the cart by their own household.
 */

function hmacKey(): Buffer {
    // A key derived for this use only, so no other NEXTAUTH_SECRET-keyed token can stand in for it.
    return crypto.createHash("sha256").update(`program-checkout:${config.nextAuthSecret()}`).digest();
}

function payload(programId: number, personIds: number[], householdId: number): string {
    const ids = [...new Set(personIds)].sort((a, b) => a - b);
    return `${programId}|${ids.join(",")}|${householdId}`;
}

export function signCheckout(programId: number, personIds: number[], householdId: number): string {
    return crypto.createHmac("sha256", hmacKey()).update(payload(programId, personIds, householdId)).digest("base64url");
}

/** Timing-safe check that `sig` signs exactly these people in this household for this program. */
export function verifyCheckout(programId: number, personIds: number[], householdId: number, sig: string | null | undefined): boolean {
    if (!sig) return false;
    const a = crypto.createHash("sha256").update(sig).digest();
    const b = crypto.createHash("sha256").update(signCheckout(programId, personIds, householdId)).digest();
    return crypto.timingSafeEqual(a, b);
}
