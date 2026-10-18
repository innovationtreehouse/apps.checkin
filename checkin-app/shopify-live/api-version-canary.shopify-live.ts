/**
 * @jest-environment node
 */
/**
 * LIVE canary: the pinned Admin API version (lib/shopify/client.ts SHOPIFY_API_VERSION)
 * is still served as requested and not deprecation-flagged. Shopify sunsets
 * versions quarterly; when the pin lapses, requests get silently served by the
 * oldest supported version — this turns that into a red nightly instead of a
 * subtle prod behavior change.
 */
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/email", () => ({ sendEmail: jest.fn() }));

import { getAccessToken, shopifyFetch, SHOPIFY_API_VERSION } from "@/lib/shopify/client";
import { ensureLiveStore, adminUrl } from "./helpers";

describe("live: pinned API version canary", () => {
    beforeAll(() => {
        ensureLiveStore();
    });

    it(`shop.json answers on ${SHOPIFY_API_VERSION} without deprecation or version fallback`, async () => {
        const token = await getAccessToken();
        expect(token).not.toBeNull();

        const res = await shopifyFetch(
            adminUrl("shop.json"),
            { headers: { "X-Shopify-Access-Token": token! } },
            "live shop.json canary",
        );
        expect(res.status).toBe(200);

        // Served version must be the requested pin — a mismatch means Shopify
        // no longer supports it and silently substituted another version.
        expect(res.headers.get("x-shopify-api-version")).toBe(SHOPIFY_API_VERSION);
        // Any value here means the call pattern is deprecated on this version.
        expect(res.headers.get("x-shopify-api-deprecated-reason")).toBeNull();

        const body = (await res.json()) as { shop: { myshopify_domain: string } };
        expect(body.shop.myshopify_domain).toBe(process.env.SHOPIFY_STORE_DOMAIN);
    });
});
