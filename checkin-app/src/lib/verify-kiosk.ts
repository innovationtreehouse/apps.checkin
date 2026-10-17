import crypto from "crypto";
import { config } from "./config";
import { stampKioskSeen } from "./kioskSeen";

/**
 * Verify an Ed25519 signature from the kiosk client.
 *
 * The kiosk signs: `${timestamp}:${nonce}:${method}:${path}:${body}`
 * Headers: X-Kiosk-Timestamp, X-Kiosk-Nonce, X-Kiosk-Signature (hex-encoded)
 *
 * Rejects if:
 *  - Missing headers
 *  - Timestamp older than MAX_AGE_SECONDS
 *  - Invalid signature against ALL configured public keys
 *  - Nonce already seen within the freshness window (replay)
 *
 * The nonce is bound INTO the signed message (so it can't be swapped) AND
 * checked against a recently-seen set (so a captured request can't be replayed
 * verbatim within the 60s timestamp window). Both are required: binding alone
 * stops tampering, not replay.
 *
 * The message format is a contract with the Python kiosk client
 * (client/client.py) — a deployed kiosk signing a different format fails every
 * request here. It is pinned by the golden vector in
 * client/kiosk-signing-vector.test.json, which this module's test and
 * client/test_signing_vector.py both check, so a change on either side that
 * isn't mirrored turns that side red.
 *
 * Supports multiple comma-separated public keys in KIOSK_PUBLIC_KEY env var.
 * Each key should be a hex-encoded 32-byte Ed25519 public key.
 */

const MAX_AGE_SECONDS = 60;

// ponytail: in-memory nonce cache — single-instance only; move to Redis/KV if the app runs multi-instance/serverless.
// nonce -> expiry (epoch ms). Pruned on insert; bounded by ~60s of kiosk traffic.
const seenNonces = new Map<string, number>();

/**
 * Parse KIOSK_PUBLIC_KEY env var into an array of Buffers.
 * Supports comma-separated keys for multiple kiosks / key rotation.
 * Returns empty array if not configured.
 */
export function getKioskPublicKeys(): Buffer[] {
    const raw = config.kioskPublicKey();
    if (!raw) return [];
    return raw
        .split(",")
        .map(k => k.trim())
        .filter(k => k.length > 0)
        .map(k => Buffer.from(k, "hex"));
}

export type VerifyResult =
    | { ok: true }
    | { ok: false; status: number; error: string };

export function verifyKioskSignature(
    method: string,
    path: string,
    body: string,
    timestampHeader: string | null,
    signatureHeader: string | null,
    nonceHeader: string | null,
    publicKeys: Buffer | Buffer[]
): VerifyResult {
    if (!timestampHeader || !signatureHeader || !nonceHeader) {
        return { ok: false, status: 401, error: "Missing kiosk signature headers" };
    }

    // Normalize to array
    const keys = Array.isArray(publicKeys) ? publicKeys : [publicKeys];

    // Check timestamp freshness
    const ts = parseInt(timestampHeader, 10);
    if (isNaN(ts)) {
        return { ok: false, status: 401, error: "Invalid timestamp" };
    }
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > MAX_AGE_SECONDS) {
        return { ok: false, status: 401, error: "Timestamp too old or too far in the future" };
    }

    // Reconstruct signed message (nonce is part of the signed payload)
    const message = Buffer.from(`${timestampHeader}:${nonceHeader}:${method}:${path}:${body}`);

    // Decode signature from hex
    let sigBytes: Buffer;
    try {
        sigBytes = Buffer.from(signatureHeader, "hex");
    } catch {
        return { ok: false, status: 401, error: "Malformed signature" };
    }

    // Try each public key — succeed if ANY matches
    let verified = false;
    for (const publicKey of keys) {
        try {
            const ok = crypto.verify(
                null, // Ed25519 doesn't use a separate hash algorithm
                message,
                {
                    key: crypto.createPublicKey({
                        key: Buffer.concat([
                            // Ed25519 DER prefix for a 32-byte public key
                            Buffer.from("302a300506032b6570032100", "hex"),
                            publicKey,
                        ]),
                        format: "der",
                        type: "spki",
                    }),
                },
                sigBytes
            );
            if (ok) { verified = true; break; }
        } catch (e) {
            // Key failed — try next one
            console.error("Signature verification error with key:", e);
        }
    }

    if (!verified) {
        return { ok: false, status: 401, error: "Invalid signature" };
    }

    // Signature is valid — now enforce single-use of the nonce. Done AFTER the
    // signature check so unsigned/forged requests can't poison the cache.
    const nowMs = Date.now();
    for (const [n, expiry] of seenNonces) {
        if (expiry <= nowMs) seenNonces.delete(n);
    }
    if (seenNonces.has(nonceHeader)) {
        return { ok: false, status: 401, error: "Replay detected" };
    }
    seenNonces.set(nonceHeader, nowMs + MAX_AGE_SECONDS * 1000);
    stampKioskSeen(nowMs);

    return { ok: true };
}
