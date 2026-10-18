/**
 * Register the Shopify REVERSAL webhook subscriptions (the fast-path complement to
 * the hourly reconciler): refunds/create, orders/cancelled, disputes/create,
 * disputes/update — all pointing at /api/webhooks/shopify/reversals. Deliberately a
 * separate, simpler script than register-shopify-webhook.ts (which owns the single
 * orders/paid subscription with careful stale-duplicate handling): these topics are
 * a latency optimization over the reconciler backstop, so create-if-absent per topic
 * is enough.
 *
 *   npx tsx scripts/register-shopify-reversal-webhooks.ts --url https://<host>/api/webhooks/shopify/reversals [--commit]
 *
 * Without --commit it prints the plan and changes nothing (dry run). SHOPIFY_* creds
 * must be set, and SHOPIFY_WEBHOOK_SECRET must match the store's signing secret or
 * every delivery 401s.
 *
 * ponytail: no update/dedup pass — if a topic already points elsewhere it's left
 * alone and reported; fix duplicates in the store admin. Upgrade to the full
 * decision logic (see register-shopify-webhook.ts) only if that becomes a problem.
 */
import * as dotenv from "dotenv";
import { getAccessToken, shopifyFetch, SHOPIFY_API_VERSION } from "../src/lib/shopify/client";
import { config } from "../src/lib/config";

dotenv.config();

const TOPICS = ["refunds/create", "orders/cancelled", "disputes/create", "disputes/update"];
const EXPECTED_PATH = "/api/webhooks/shopify/reversals";

interface Webhook {
    id: number;
    topic: string;
    address: string;
}

async function main() {
    const url = process.argv.find((a, i) => process.argv[i - 1] === "--url");
    const commit = process.argv.includes("--commit");
    if (!url) throw new Error(`--url https://<host>${EXPECTED_PATH} is required.`);
    if (!url.endsWith(EXPECTED_PATH)) {
        console.warn(`Warning: --url does not end with ${EXPECTED_PATH}; deliveries won't reach the reversal handler.`);
    }

    const accessToken = await getAccessToken();
    if (!accessToken) {
        console.error("Shopify not configured (missing SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, or SHOPIFY_CLIENT_SECRET) — nothing to register.");
        process.exit(1);
    }
    const storeDomain = config.shopifyStoreDomain()!;
    const apiBase = `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}`;
    const authHeader = { "X-Shopify-Access-Token": accessToken };

    console.log(
        "NOTE: Shopify signs API-created subscriptions with the app's client secret (SHOPIFY_CLIENT_SECRET),\n" +
        "not the store's Notifications signing secret — SHOPIFY_WEBHOOK_SECRET must match or deliveries 401.\n",
    );

    for (const topic of TOPICS) {
        const listRes = await shopifyFetch(
            `${apiBase}/webhooks.json?topic=${encodeURIComponent(topic)}&limit=250`,
            { headers: authHeader },
            `Shopify list ${topic}`,
        );
        if (!listRes.ok) {
            console.error(`Shopify API error listing ${topic}: ${listRes.status} ${await listRes.text()}`);
            process.exit(1);
        }
        const existing: Webhook[] = (await listRes.json())?.webhooks ?? [];
        const match = existing.find((w) => w.address === url);
        if (match) {
            console.log(`No change: ${topic} → ${url} (id ${match.id})`);
            continue;
        }
        const others = existing.filter((w) => w.address !== url);
        if (others.length) {
            console.warn(`Note: ${topic} has ${others.length} other subscription(s) pointing elsewhere (id(s) ${others.map((w) => w.id).join(", ")}) — left as-is.`);
        }
        if (!commit) {
            console.log(`Will CREATE ${topic} → ${url}`);
            continue;
        }
        const res = await shopifyFetch(
            `${apiBase}/webhooks.json`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json", ...authHeader },
                body: JSON.stringify({ webhook: { topic, address: url, format: "json" } }),
            },
            `Shopify create ${topic}`,
        );
        if (!res.ok) {
            console.error(`Shopify API error creating ${topic}: ${res.status} ${await res.text()}`);
            process.exit(1);
        }
        const w: Webhook | undefined = (await res.json().catch(() => null))?.webhook;
        console.log(`✅ Created ${topic}${w ? `: id=${w.id}` : ` (HTTP ${res.status})`}`);
    }

    if (!commit) console.log("\nDry run — re-run with --commit to apply.");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
