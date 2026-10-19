import * as dotenv from "dotenv";
import { getAccessToken, shopifyFetch, SHOPIFY_API_VERSION } from "../src/lib/shopify/client";
import { config } from "../src/lib/config";

/**
 * Idempotently upserts the `orders/paid` webhook subscription against the
 * Shopify Admin API, pointed at a caller-supplied callback URL.
 *
 *   npx tsx scripts/register-shopify-webhook.ts --url <https://host/api/webhooks/shopify> [--commit]
 *
 * Defaults to a DRY RUN (prints the create/update/noop decision, writes nothing).
 * Pass --commit to apply it. Reuses lib/shopify/client.ts's token exchange and fetch wrapper —
 * no Prisma needed here, there's no DB write.
 *
 * Two Admin-API facts that matter (design §2/§3):
 * - Shopify signs deliveries to an API-created subscription with the APP's client
 *   secret, NOT the store's Settings → Notifications signing secret. An instance
 *   relying on a script-registered webhook needs SHOPIFY_WEBHOOK_SECRET set to the
 *   client secret's value.
 * - The API only sees subscriptions created by this app. A webhook registered
 *   manually in the store admin is invisible here and keeps firing on its own.
 */

dotenv.config();

const EXPECTED_PATH = "/api/webhooks/shopify";

function arg(flag: string): string | undefined {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (flag: string) => process.argv.includes(flag);

export interface ShopifyWebhookSubscription {
    id: number;
    topic: string;
    address: string;
}

export type WebhookAction =
    | { action: "create" }
    | { action: "update"; id: number; staleDuplicates: number[] }
    | { action: "noop"; id: number; staleDuplicates: number[] };

/**
 * Pure decision: does the orders/paid subscription need creating, updating, or
 * nothing? Prefers a subscription already at the desired address; any other
 * orders/paid subscriptions are surfaced as staleDuplicates so the caller can
 * warn — Shopify allows several subscriptions on one topic, and a stale one
 * keeps firing at a dead URL until removed.
 */
export function decideWebhookAction(existing: ShopifyWebhookSubscription[], desiredAddress: string): WebhookAction {
    const matches = existing.filter((w) => w.topic === "orders/paid");
    if (matches.length === 0) return { action: "create" };
    const target = matches.find((w) => w.address === desiredAddress) ?? matches[0];
    const staleDuplicates = matches.filter((w) => w.id !== target.id).map((w) => w.id);
    if (target.address === desiredAddress) return { action: "noop", id: target.id, staleDuplicates };
    return { action: "update", id: target.id, staleDuplicates };
}

async function main() {
    const url = arg("--url");
    const commit = hasFlag("--commit");

    if (!url) {
        throw new Error("--url <https://host/api/webhooks/shopify> is required.");
    }

    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`--url is not a valid URL: ${url}`);
    }
    if (parsed.protocol !== "https:") {
        throw new Error(`--url must be https — got "${parsed.protocol}//..." (${url})`);
    }
    if (!parsed.pathname.endsWith(EXPECTED_PATH)) {
        console.warn(`Warning: --url path is "${parsed.pathname}", expected it to end with "${EXPECTED_PATH}". Continuing anyway.`);
    }

    const accessToken = await getAccessToken();
    if (!accessToken) {
        console.error("Shopify not configured (missing SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, or SHOPIFY_CLIENT_SECRET) — nothing to register.");
        process.exit(1);
    }

    // getAccessToken() only succeeds once storeDomain is confirmed non-null.
    const storeDomain = config.shopifyStoreDomain()!;
    const apiBase = `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}`;

    // topic filter + max page size keep the read aligned with what
    // decideWebhookAction assumes it saw (an unfiltered list is capped at 50
    // entries, so the orders/paid subscription could fall off the first page).
    const listRes = await shopifyFetch(`${apiBase}/webhooks.json?topic=orders%2Fpaid&limit=250`, {
        headers: { "X-Shopify-Access-Token": accessToken },
    }, "Shopify list webhooks");

    if (!listRes.ok) {
        console.error(`Shopify API error listing webhooks: ${listRes.status} ${await listRes.text()}`);
        process.exit(1);
    }

    const listData = await listRes.json();
    const webhooks: ShopifyWebhookSubscription[] = listData.webhooks ?? [];
    const decision = decideWebhookAction(webhooks, url);

    console.log(
        "NOTE: Shopify signs deliveries to an API-created subscription with the app's client secret\n" +
        "(SHOPIFY_CLIENT_SECRET), NOT the store's Settings → Notifications signing secret — set\n" +
        "SHOPIFY_WEBHOOK_SECRET to match, or every delivery will 401 (design §2/§4). Subscriptions\n" +
        "registered manually in the store admin are invisible to this script and fire independently.\n",
    );
    if (decision.action !== "create" && decision.staleDuplicates.length > 0) {
        console.warn(`Warning: ${decision.staleDuplicates.length} other orders/paid subscription(s) (id(s) ${decision.staleDuplicates.join(", ")}) point elsewhere and keep firing until removed in the store admin.`);
    }

    if (decision.action === "noop") {
        console.log(`No change needed: orders/paid webhook ${decision.id} already points at ${url}`);
        return;
    }

    const creating = decision.action === "create";
    if (creating) {
        console.log(`Will CREATE an orders/paid webhook subscription pointing at ${url}`);
    } else {
        console.log(`Will UPDATE orders/paid webhook ${decision.id} address to ${url}`);
    }

    if (!commit) {
        console.log("\nDRY RUN — no changes written. Re-run with --commit to apply.");
        return;
    }

    const body = JSON.stringify({ webhook: { topic: "orders/paid", address: url, format: "json" } });
    const mutateRes = await shopifyFetch(
        creating ? `${apiBase}/webhooks.json` : `${apiBase}/webhooks/${decision.id}.json`,
        {
            method: creating ? "POST" : "PUT",
            headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
            body,
        },
        `Shopify ${creating ? "create" : "update"} webhook`,
    );

    if (!mutateRes.ok) {
        console.error(`Shopify API error ${creating ? "creating" : "updating"} webhook: ${mutateRes.status} ${await mutateRes.text()}`);
        process.exit(1);
    }

    // The 2xx contract is {webhook:{...}} — don't crash the success report on an
    // unexpected body; the mutation has already applied at this point.
    const result = await mutateRes.json().catch(() => null);
    const w = result?.webhook;
    console.log(`✅ ${creating ? "Created" : "Updated"} orders/paid webhook${w ? `: id=${w.id} address=${w.address}` : ` (HTTP ${mutateRes.status}, unexpected response body)`}`);
}

// Guarded so importing decideWebhookAction (e.g. from the unit test) doesn't
// also run the CLI's main().
if (require.main === module) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
