import { NextResponse } from "next/server";
import { Webhook, WebhookVerificationError } from "svix";
import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { config } from "@/lib/config";
import { withWebhook } from "@/lib/webhookAuth";
import { canonicalizeEmail } from "@/lib/emailNormalize";

/**
 * Verify Resend's inbound webhook — signed via Svix (svix-id/svix-timestamp/
 * svix-signature headers) over the raw body. Config-not-set is a server error
 * (500); a missing/invalid signature is unauthorized (401) — same shape as the
 * Shopify HMAC / Zoho shared-secret verify fns.
 */
function verifyResendSignature(req: Request, rawBody: string): { ok: true } | { ok: false; status: number; error: string } {
    const secret = config.resendWebhookSecret();
    if (!secret) {
        logger.error("Resend webhook received but RESEND_WEBHOOK_SECRET is not configured.");
        return { ok: false, status: 500, error: "Configuration Error" };
    }

    const headers = {
        "svix-id": req.headers.get("svix-id") ?? "",
        "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
        "svix-signature": req.headers.get("svix-signature") ?? "",
    };

    try {
        new Webhook(secret).verify(rawBody, headers);
        return { ok: true };
    } catch (err) {
        if (err instanceof WebhookVerificationError) {
            return { ok: false, status: 401, error: "Invalid signature" };
        }
        throw err; // unexpected — withWebhook's top-level catch logs + 500s it
    }
}

type ResendWebhookEvent = {
    type: string;
    data?: { to?: string | string[]; subject?: string; email_id?: string };
};

function toAddresses(data: ResendWebhookEvent["data"]): string[] {
    if (!data?.to) return [];
    return Array.isArray(data.to) ? data.to : [data.to];
}

/**
 * Find every Person whose stored email matches `address` under the shared
 * Gmail/+tag-aware canonicalization (lib/emailNormalize) — Resend echoes back
 * exactly the address sendEmail submitted, so this is almost always an exact
 * hit; canonicalizing only matters for a stray case/punctuation difference.
 *
 * ponytail: O(n) scan over people with an email set, no indexed normalized
 * column. Fine at this org's membership-list scale (bounce/complaint events
 * are rare and rate-limited); add an indexed column if the Person table grows
 * large enough for this to show up in practice.
 */
async function findPersonIdsByEmail(address: string): Promise<number[]> {
    const normalized = canonicalizeEmail(address);
    const people = await prisma.person.findMany({
        where: { email: { not: null } },
        select: { id: true, email: true },
    });
    return people.filter((p) => p.email && canonicalizeEmail(p.email) === normalized).map((p) => p.id);
}

/**
 * POST /api/webhooks/resend — Resend email-deliverability events.
 *
 *   email.bounced / email.complained → stamp Person.emailUndeliverableAt (flag).
 *   email.delivered                  → clear it (self-healing: the address works again).
 *   email.delivery_delayed           → log only, no flag (a delay isn't a broken address).
 *   anything else                    → acknowledged and ignored, so Resend stops retrying.
 *
 * An address with no matching Person no-ops cleanly (still 200s). Setting/
 * clearing the same flag more than once is harmless — idempotent by design, no
 * dedupe bookkeeping needed.
 */
export const POST = withWebhook({ provider: "resend", verify: verifyResendSignature }, async (_req, event: ResendWebhookEvent) => {
    const addresses = toAddresses(event.data);

    switch (event.type) {
        case "email.bounced":
        case "email.complained": {
            for (const address of addresses) {
                const ids = await findPersonIdsByEmail(address);
                if (ids.length === 0) continue;
                await prisma.person.updateMany({ where: { id: { in: ids } }, data: { emailUndeliverableAt: new Date() } });
            }
            return NextResponse.json({ ok: true });
        }
        case "email.delivered": {
            for (const address of addresses) {
                const ids = await findPersonIdsByEmail(address);
                if (ids.length === 0) continue;
                await prisma.person.updateMany({ where: { id: { in: ids } }, data: { emailUndeliverableAt: null } });
            }
            return NextResponse.json({ ok: true });
        }
        case "email.delivery_delayed":
            logger.warn(`[RESEND WEBHOOK] Delivery delayed for ${addresses.join(", ") || "unknown address"}`);
            return NextResponse.json({ ok: true, ignored: "delivery_delayed" });
        default:
            return NextResponse.json({ ok: true, ignored: event.type });
    }
});
