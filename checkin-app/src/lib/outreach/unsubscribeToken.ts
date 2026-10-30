import crypto from "crypto";
import { config } from "@/lib/config";
import { constantTimeEqual } from "@/lib/signatureCompare";

/**
 * Signed, session-less unsubscribe token: HMAC-SHA256 over the bare personId, keyed off
 * NEXTAUTH_SECRET. Mirrors the Shopify webhook HMAC (src/lib/signatureCompare.ts) — NOT
 * verify-kiosk.ts's Ed25519 scheme, which is asymmetric and the wrong model for a
 * server-generated-and-verified token.
 *
 * The URL carries both the id and the signature (`?p=<id>&sig=<hmac>`) rather than trusting
 * a bare id: verify() recomputes sign(id) and timing-safe compares it against the provided
 * sig, so a tampered id fails unless the attacker also forges its signature.
 */

function hmacKey(): Buffer {
    // Derive a distinct key from NEXTAUTH_SECRET rather than using it directly, so this
    // token family can't be replayed against/confused with any other NEXTAUTH_SECRET-keyed use.
    return crypto.createHash("sha256").update(`outreach-unsubscribe:${config.nextAuthSecret()}`).digest();
}

/** The signature for a given personId. */
export function sign(personId: number): string {
    return crypto.createHmac("sha256", hmacKey()).update(String(personId)).digest("base64url");
}

/** Timing-safe check that `token` is the signature for `personId`. */
export function verify(personId: number, token: string | null | undefined): boolean {
    if (!token) return false;
    return constantTimeEqual(token, sign(personId));
}
