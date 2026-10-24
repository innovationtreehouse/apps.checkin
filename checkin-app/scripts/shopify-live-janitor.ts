/**
 * Janitor for the Shopify LIVE test suite: deletes citest-tagged products and
 * PRG9999999xx discount codes older than MAX_AGE_HOURS from the DEV store, so
 * a crashed run can never accumulate junk. Runs before and after the suite in
 * .github/workflows/shopify-live.yml; safe to run by hand:
 *
 *   npx tsx scripts/shopify-live-janitor.ts
 *
 * Refuses to run against anything but the allowed dev store (guard.ts).
 */
import { assertLiveTestStore, CITEST_PREFIX, CITEST_PROGRAM_ID_BASE } from "../shopify-live/guard";

const MAX_AGE_HOURS = Number(process.env.SHOPIFY_LIVE_JANITOR_MAX_AGE_HOURS ?? 24);
const API_VERSION = "2026-01"; // keep aligned with lib/shopify/client.ts SHOPIFY_API_VERSION

// Matches the reserved live-test program-id range in minted code titles.
const TEST_DISCOUNT_RE = new RegExp(`^PRG${CITEST_PROGRAM_ID_BASE.toString().slice(0, -2)}\\d{2}-`);

async function main(): Promise<void> {
    const domain = assertLiveTestStore(process.env);
    const base = `https://${domain}/admin/api/${API_VERSION}`;

    const tokenRes = await fetch(`${base.replace(/\/admin\/api\/.*$/, "")}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: process.env.SHOPIFY_CLIENT_ID!,
            client_secret: process.env.SHOPIFY_CLIENT_SECRET!,
        }).toString(),
        signal: AbortSignal.timeout(20_000),
    });
    if (!tokenRes.ok) throw new Error(`janitor: token exchange failed ${tokenRes.status}`);
    const token = ((await tokenRes.json()) as { access_token: string }).access_token;
    const headers = { "X-Shopify-Access-Token": token };

    const cutoff = Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000;
    const isStale = (createdAt: string) => new Date(createdAt).getTime() < cutoff;
    let deleted = 0;

    const productsRes = await fetch(`${base}/products.json?limit=250&fields=id,title,created_at`, {
        headers,
        signal: AbortSignal.timeout(20_000),
    });
    if (!productsRes.ok) throw new Error(`janitor: products list failed ${productsRes.status}`);
    const { products } = (await productsRes.json()) as { products: { id: number; title: string; created_at: string }[] };
    for (const p of products) {
        if (p.title.includes(CITEST_PREFIX) && isStale(p.created_at)) {
            const del = await fetch(`${base}/products/${p.id}.json`, { method: "DELETE", headers, signal: AbortSignal.timeout(20_000) });
            console.log(`janitor: product ${p.id} "${p.title}" -> ${del.status}`);
            deleted++;
        }
    }

    // Discount codes are GraphQL-native (mintMemberDiscountCode uses
    // discountCodeBasicCreate; the REST price_rules API needs a scope the app
    // deliberately doesn't have — the canary's very first run caught this).
    const gqlHeaders = { ...headers, "Content-Type": "application/json" };
    const listRes = await fetch(`${base}/graphql.json`, {
        method: "POST",
        headers: gqlHeaders,
        body: JSON.stringify({
            query: `{ codeDiscountNodes(first: 250) { nodes { id codeDiscount { __typename ... on DiscountCodeBasic { title startsAt } } } } }`,
        }),
        signal: AbortSignal.timeout(20_000),
    });
    if (!listRes.ok) throw new Error(`janitor: discount list failed ${listRes.status}`);
    const listBody = (await listRes.json()) as {
        errors?: unknown[];
        data?: { codeDiscountNodes: { nodes: { id: string; codeDiscount: { __typename: string; title?: string; startsAt?: string } }[] } };
    };
    if (listBody.errors?.length) throw new Error(`janitor: discount list errors ${JSON.stringify(listBody.errors).slice(0, 200)}`);
    for (const n of listBody.data?.codeDiscountNodes.nodes ?? []) {
        const { title, startsAt } = n.codeDiscount;
        // startsAt is the mint time for our codes — same staleness axis the
        // REST sweep used created_at for.
        if (title && startsAt && TEST_DISCOUNT_RE.test(title) && isStale(startsAt)) {
            const del = await fetch(`${base}/graphql.json`, {
                method: "POST",
                headers: gqlHeaders,
                body: JSON.stringify({
                    query: `mutation($id: ID!) { discountCodeDelete(id: $id) { deletedCodeDiscountId userErrors { message } } }`,
                    variables: { id: n.id },
                }),
                signal: AbortSignal.timeout(20_000),
            });
            console.log(`janitor: discount ${n.id} "${title}" -> ${del.status}`);
            deleted++;
        }
    }

    console.log(`janitor: done — ${deleted} stale citest resource(s) deleted (cutoff ${MAX_AGE_HOURS}h).`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
