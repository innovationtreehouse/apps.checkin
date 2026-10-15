import * as dotenv from "dotenv";
import crypto from "crypto";
import { createInterface } from "readline/promises";
import { getAccessToken, shopifyFetch } from "../src/lib/shopify";
import { config } from "../src/lib/config";
import { PROD_STORE_DOMAIN } from "../shopify-live/guard";

/**
 * Checks, against a real DEV Shopify store, the idempotency-key behaviour the
 * program-stock writer (#2055, lib/shopify.ts) relies on. Same Admin API version
 * (2026-04), same mutations, same `@idempotent(key:)` directive.
 *
 *   cd checkin-app
 *   npx tsx --env-file=<dev-store env file> scripts/shopify-idempotency-check.ts
 *
 * Env (the app's own Shopify vars; a plain `.env` in checkin-app/ is also read):
 *   SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET
 *
 * It creates a draft product "IDEMPOTENCY CHECK – delete me", then:
 *   a. inventorySetQuantities key K1, 0 → 5                      → applied, quantity 5
 *   b. the identical request again with K1                       → original result, quantity still 5
 *   c. K1 with a different quantity (0 → 7)                      → refused, quantity still 5
 *   d. inventoryActivate with key KA, sent twice                 → second accepted, one level, no change
 * (d runs first in practice: the item must be stocked before a–c can set it, as in #2055.)
 * The product is always deleted. Exit 0 only when every check passes.
 *
 * Refuses the production store outright. Any other domain must look like a dev
 * store (equals SHOPIFY_LIVE_ALLOWED_DOMAIN, or contains dev/test/staging/sandbox)
 * unless --i-know-this-is-not-prod is passed. Never prints the token.
 */

dotenv.config();

const API_VERSION = "2026-04";
const PRODUCT_TITLE = "IDEMPOTENCY CHECK – delete me";

interface GqlReply {
    status: number;
    data?: Record<string, unknown>;
    errors?: unknown[];
}
type UserError = { code?: string; field?: string[]; message: string };

let endpoint = "";
let accessToken = "";

async function gql(query: string, variables: Record<string, unknown> = {}): Promise<GqlReply> {
    const res = await shopifyFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
        body: JSON.stringify({ query, variables }),
    }, "idempotency check");
    const body = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown>; errors?: unknown[] };
    return { status: res.status, data: body.data, errors: body.errors };
}

/** Like gql() but throws on any transport/GraphQL/user error — for setup and cleanup only. */
async function gqlOk<T>(query: string, variables: Record<string, unknown>, field: string): Promise<T> {
    const r = await gql(query, variables);
    const payload = r.data?.[field] as (T & { userErrors?: UserError[] }) | undefined;
    if (r.status !== 200 || r.errors?.length || !payload || payload.userErrors?.length) {
        throw new Error(`${field} failed: ${JSON.stringify({ status: r.status, errors: r.errors, payload })}`);
    }
    return payload;
}

const SET_STOCK = `
    mutation ProgramStockSet($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
        inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
            inventoryAdjustmentGroup { id }
            userErrors { code field message }
        }
    }`;

const ACTIVATE_KEYED = `
    mutation ProgramStockActivate($inventoryItemId: ID!, $locationId: ID!, $idempotencyKey: String!) {
        inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) @idempotent(key: $idempotencyKey) {
            inventoryLevel { id }
            userErrors { field message }
        }
    }`;

const ACTIVATE_PLAIN = `
    mutation Activate($inventoryItemId: ID!, $locationId: ID!) {
        inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
            inventoryLevel { id }
            userErrors { field message }
        }
    }`;

const READ_LEVELS = `
    query Levels($id: ID!) {
        inventoryItem(id: $id) {
            inventoryLevels(first: 50) { nodes { id location { id } quantities(names: ["available"]) { quantity } } }
        }
    }`;

interface Level { id: string; location: { id: string }; quantities: { quantity: number }[] }

async function levelsAt(itemId: string, locationId: string): Promise<Level[]> {
    const r = await gql(READ_LEVELS, { id: itemId });
    const item = r.data?.inventoryItem as { inventoryLevels: { nodes: Level[] } } | undefined;
    if (!item) throw new Error(`inventoryItem read failed: ${JSON.stringify(r)}`);
    return item.inventoryLevels.nodes.filter((l) => l.location.id === locationId);
}

async function availableAt(itemId: string, locationId: string): Promise<number | null> {
    return (await levelsAt(itemId, locationId))[0]?.quantities[0]?.quantity ?? null;
}

function setVars(itemId: string, locationId: string, changeFromQuantity: number, quantity: number, key: string) {
    return {
        input: {
            name: "available",
            reason: "correction",
            quantities: [{ inventoryItemId: itemId, locationId, quantity, changeFromQuantity }],
        },
        idempotencyKey: key,
    };
}

function setResult(r: GqlReply) {
    const p = r.data?.inventorySetQuantities as { inventoryAdjustmentGroup: { id: string } | null; userErrors: UserError[] } | undefined;
    return { status: r.status, errors: r.errors, group: p?.inventoryAdjustmentGroup?.id ?? null, userErrors: p?.userErrors ?? [] };
}

const results: { check: string; pass: boolean; note: string }[] = [];
function report(check: string, pass: boolean, note: string, raw: unknown) {
    results.push({ check, pass, note });
    console.log(`\n[${pass ? "PASS" : "FAIL"}] ${check} — ${note}`);
    console.log(JSON.stringify(raw, null, 2));
}

function guardStore(domain: string): void {
    if (domain === PROD_STORE_DOMAIN) {
        throw new Error(`Refusing: ${domain} is the PRODUCTION store. This script creates and deletes products.`);
    }
    const looksDev = domain === process.env.SHOPIFY_LIVE_ALLOWED_DOMAIN || /dev|test|staging|sandbox/i.test(domain);
    if (!looksDev && !process.argv.includes("--i-know-this-is-not-prod")) {
        throw new Error(`Refusing: ${domain} does not look like a dev store. Re-run with --i-know-this-is-not-prod if it is one.`);
    }
}

async function checkActivate(itemId: string, locationId: string): Promise<void> {
    const key = `idempotency-check-activate-${crypto.randomUUID()}`;
    const vars = { inventoryItemId: itemId, locationId, idempotencyKey: key };
    const first = await gql(ACTIVATE_KEYED, vars);
    const firstPayload = first.data?.inventoryActivate as { inventoryLevel: { id: string } | null; userErrors: UserError[] } | undefined;
    if (first.errors?.length || !firstPayload) {
        report("d. inventoryActivate keyed x2", false, "API REJECTED @idempotent on inventoryActivate — #2055's activate call would fail", { first });
        await gqlOk(ACTIVATE_PLAIN, { inventoryItemId: itemId, locationId }, "inventoryActivate");
        return;
    }
    const second = await gql(ACTIVATE_KEYED, vars);
    const secondPayload = second.data?.inventoryActivate as { inventoryLevel: { id: string } | null; userErrors: UserError[] } | undefined;
    const levels = await levelsAt(itemId, locationId);
    const quantity = levels[0]?.quantities[0]?.quantity ?? null;
    const pass = !firstPayload.userErrors.length && !second.errors?.length && !!secondPayload && !secondPayload.userErrors.length
        && secondPayload.inventoryLevel?.id === firstPayload.inventoryLevel?.id && levels.length === 1 && quantity === 0;
    report("d. inventoryActivate keyed x2", pass,
        pass ? "second call accepted, same level, one level, available 0" : "see raw fields",
        { key, first: { status: first.status, payload: firstPayload }, second: { status: second.status, errors: second.errors, payload: secondPayload }, levelsAtLocation: levels.length, available: quantity });
    if (levels.length === 0) await gqlOk(ACTIVATE_PLAIN, { inventoryItemId: itemId, locationId }, "inventoryActivate");
}

async function checkSetQuantities(itemId: string, locationId: string): Promise<void> {
    const k1 = `idempotency-check-set-${crypto.randomUUID()}`;

    const a = setResult(await gql(SET_STOCK, setVars(itemId, locationId, 0, 5, k1)));
    const qa = await availableAt(itemId, locationId);
    report("a. set 0→5 with K1", !a.errors?.length && !a.userErrors.length && qa === 5, `available now ${qa}`, { key: k1, ...a, available: qa });

    // changeFromQuantity is 0 but available is 5: a replay Shopify did NOT dedupe shows up as CHANGE_FROM_QUANTITY_STALE.
    const b = setResult(await gql(SET_STOCK, setVars(itemId, locationId, 0, 5, k1)));
    const qb = await availableAt(itemId, locationId);
    const bPass = !b.errors?.length && !b.userErrors.length && b.group === a.group && qb === 5;
    report("b. identical replay with K1", bPass,
        bPass ? "original result returned, available still 5" : `key NOT honoured as a replay (available ${qb})`,
        { key: k1, ...b, firstGroup: a.group, available: qb });

    const c = setResult(await gql(SET_STOCK, setVars(itemId, locationId, 0, 7, k1)));
    const qc = await availableAt(itemId, locationId);
    const refused = !!c.errors?.length || c.userErrors.length > 0;
    report("c. K1 reused with quantity 7", refused && qc === 5,
        refused ? `refused, available ${qc}` : `ACCEPTED a different request under K1 (available ${qc})`,
        { key: k1, ...c, available: qc });
}

async function main(): Promise<number> {
    const domain = config.shopifyStoreDomain();
    if (!domain || !config.shopifyClientId() || !config.shopifyClientSecret()) {
        throw new Error("Missing SHOPIFY_STORE_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET.");
    }
    guardStore(domain);

    console.log(`Store: ${domain}  (Admin API ${API_VERSION})`);
    console.log(`Creates and then deletes a draft product "${PRODUCT_TITLE}" and sets its stock.`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("Proceed? [y/N] ");
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
        console.log("Aborted.");
        return 1;
    }

    const token = await getAccessToken();
    if (!token) throw new Error("Could not mint an Admin API access token (see the warning above).");
    accessToken = token;
    endpoint = `https://${domain}/admin/api/${API_VERSION}/graphql.json`;

    let productId: string | null = null;
    try {
        const created = await gqlOk<{ product: { id: string; variants: { nodes: { inventoryItem: { id: string } }[] } } }>(`
            mutation Create($product: ProductCreateInput!) {
                productCreate(product: $product) {
                    product { id variants(first: 1) { nodes { inventoryItem { id } } } }
                    userErrors { field message }
                }
            }`, { product: { title: PRODUCT_TITLE, status: "DRAFT" } }, "productCreate");
        productId = created.product.id;
        const itemId = created.product.variants.nodes[0].inventoryItem.id;
        await gqlOk(`
            mutation Track($id: ID!) {
                inventoryItemUpdate(id: $id, input: { tracked: true }) { inventoryItem { id tracked } userErrors { field message } }
            }`, { id: itemId }, "inventoryItemUpdate");

        const locs = await gql(`{ locations(first: 50) { nodes { id isActive } } }`);
        const nodes = (locs.data?.locations as { nodes: { id: string; isActive: boolean }[] } | undefined)?.nodes ?? [];
        const locationId = nodes.find((l) => l.isActive)?.id;
        if (!locationId) throw new Error(`No active location: ${JSON.stringify(locs)}`);
        console.log(`\nProduct ${productId}\nInventory item ${itemId}\nLocation ${locationId}`);

        await checkActivate(itemId, locationId);
        await checkSetQuantities(itemId, locationId);
    } catch (err) {
        report("run", false, "aborted before all checks finished", { error: String(err) });
    } finally {
        if (productId) {
            try {
                await gqlOk(`mutation Del($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId userErrors { field message } } }`,
                    { input: { id: productId } }, "productDelete");
                console.log(`\nDeleted ${productId}.`);
            } catch (err) {
                console.error(`\nCLEANUP FAILED — delete "${PRODUCT_TITLE}" (${productId}) by hand: ${String(err)}`);
            }
        }
    }

    const order = (c: string) => c.charAt(0);
    console.log("\n=== Summary (paste back) ===");
    console.log(`store ${domain} · API ${API_VERSION}`);
    for (const r of [...results].sort((x, y) => order(x.check).localeCompare(order(y.check)))) {
        console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}  — ${r.note}`);
    }
    return results.length >= 4 && results.every((r) => r.pass) ? 0 : 1;
}

main().then(
    (code) => process.exit(code),
    (err) => {
        console.error(String(err instanceof Error ? err.message : err));
        process.exit(1);
    },
);
