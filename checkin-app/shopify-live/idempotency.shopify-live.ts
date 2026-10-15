/**
 * @jest-environment node
 */
/**
 * LIVE contract: Shopify honours `@idempotent(key:)` on the inventory mutations
 * the program-stock writer (#2055) sends — Admin API 2026-04, same mutation
 * shapes. Each check logs one `[idempotency] <check>: PASS|FAIL` line plus the
 * raw response fields, so the result reads straight off the workflow log.
 *
 * d runs first: the item must be stocked at the location before a–c can set it.
 */
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/email", () => ({ sendEmail: jest.fn() }));

import crypto from "crypto";
import { getAccessToken, shopifyFetch } from "@/lib/shopify";
import { ensureLiveStore, testRunName, trackProduct, cleanupTracked } from "./helpers";

const API_VERSION = "2026-04";

interface GqlReply { status: number; data?: Record<string, unknown>; errors?: unknown[] }
interface UserError { code?: string; field?: string[]; message: string }
interface Level { id: string; location: { id: string }; quantities: { quantity: number }[] }
type ActivatePayload = { inventoryLevel: { id: string } | null; userErrors: UserError[] } | undefined;

async function gql(query: string, variables: Record<string, unknown> = {}): Promise<GqlReply> {
    const token = await getAccessToken();
    if (!token) throw new Error("shopify-live: could not mint an Admin API token");
    const res = await shopifyFetch(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({ query, variables }),
    }, "live idempotency GraphQL");
    const body = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown>; errors?: unknown[] };
    return { status: res.status, data: body.data, errors: body.errors };
}

/** For setup only: throws on any transport, GraphQL or user error. */
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

function report(check: string, pass: boolean, note: string, raw: unknown): void {
    // Straight to stdout: jest's console capture buries console.log under stack frames.
    process.stdout.write(`\n[idempotency] ${check}: ${pass ? "PASS" : "FAIL"} — ${note}\n${JSON.stringify(raw, null, 2)}\n`);
}

describe("live: Shopify idempotency keys on inventory mutations (#2055)", () => {
    let itemId: string;
    let locationId: string;
    const k1 = `citest-set-${crypto.randomUUID()}`;
    let firstGroup: string | null = null;

    async function levelsAt(): Promise<Level[]> {
        const r = await gql(`query($id: ID!) { inventoryItem(id: $id) {
            inventoryLevels(first: 50) { nodes { id location { id } quantities(names: ["available"]) { quantity } } } } }`, { id: itemId });
        const item = r.data?.inventoryItem as { inventoryLevels: { nodes: Level[] } } | undefined;
        if (!item) throw new Error(`inventoryItem read failed: ${JSON.stringify(r)}`);
        return item.inventoryLevels.nodes.filter((l) => l.location.id === locationId);
    }
    const available = async () => (await levelsAt())[0]?.quantities[0]?.quantity ?? null;

    async function set(changeFromQuantity: number, quantity: number) {
        const r = await gql(SET_STOCK, {
            input: { name: "available", reason: "correction", quantities: [{ inventoryItemId: itemId, locationId, quantity, changeFromQuantity }] },
            idempotencyKey: k1,
        });
        const p = r.data?.inventorySetQuantities as { inventoryAdjustmentGroup: { id: string } | null; userErrors: UserError[] } | undefined;
        return { status: r.status, errors: r.errors, group: p?.inventoryAdjustmentGroup?.id ?? null, userErrors: p?.userErrors ?? [] };
    }

    beforeAll(async () => {
        ensureLiveStore();
        const created = await gqlOk<{ product: { id: string; variants: { nodes: { inventoryItem: { id: string } }[] } } }>(`
            mutation($product: ProductCreateInput!) {
                productCreate(product: $product) {
                    product { id variants(first: 1) { nodes { inventoryItem { id } } } }
                    userErrors { field message }
                }
            }`, { product: { title: testRunName("idempotency"), status: "DRAFT" } }, "productCreate");
        trackProduct(created.product.id.split("/").pop());
        itemId = created.product.variants.nodes[0].inventoryItem.id;
        await gqlOk(`mutation($id: ID!) { inventoryItemUpdate(id: $id, input: { tracked: true }) { inventoryItem { id } userErrors { field message } } }`,
            { id: itemId }, "inventoryItemUpdate");
        const locs = await gql(`{ locations(first: 50) { nodes { id isActive } } }`);
        const active = (locs.data?.locations as { nodes: { id: string; isActive: boolean }[] } | undefined)?.nodes.find((l) => l.isActive);
        if (!active) throw new Error(`no active location: ${JSON.stringify(locs)}`);
        locationId = active.id;
        process.stdout.write(`\n[idempotency] store ${process.env.SHOPIFY_STORE_DOMAIN} · API ${API_VERSION} · product ${created.product.id} · item ${itemId} · location ${locationId}\n`);
    });

    afterAll(async () => {
        await cleanupTracked();
    });

    it("d. inventoryActivate with a key, sent twice, is accepted once with no double effect", async () => {
        const vars = { inventoryItemId: itemId, locationId, idempotencyKey: `citest-activate-${crypto.randomUUID()}` };
        const first = await gql(ACTIVATE_KEYED, vars);
        const firstPayload = first.data?.inventoryActivate as ActivatePayload;
        if (first.errors?.length || !firstPayload) {
            report("d. inventoryActivate keyed x2", false, "API REJECTED @idempotent on inventoryActivate — #2055's activate call would fail", first);
            await gqlOk(ACTIVATE_PLAIN, { inventoryItemId: itemId, locationId }, "inventoryActivate");
            throw new Error("inventoryActivate rejected the idempotency key");
        }
        const second = await gql(ACTIVATE_KEYED, vars);
        const secondPayload = second.data?.inventoryActivate as ActivatePayload;
        const levels = await levelsAt();
        const quantity = levels[0]?.quantities[0]?.quantity ?? null;
        const pass = !firstPayload.userErrors.length && !second.errors?.length && !!secondPayload && !secondPayload.userErrors.length
            && secondPayload.inventoryLevel?.id === firstPayload.inventoryLevel?.id && levels.length === 1 && quantity === 0;
        report("d. inventoryActivate keyed x2", pass, pass ? "second call accepted, same level, one level, available 0" : "see raw fields",
            { key: vars.idempotencyKey, first: { status: first.status, payload: firstPayload }, second: { status: second.status, errors: second.errors, payload: secondPayload }, levelsAtLocation: levels.length, available: quantity });
        if (levels.length === 0) await gqlOk(ACTIVATE_PLAIN, { inventoryItemId: itemId, locationId }, "inventoryActivate");
        expect(pass).toBe(true);
    });

    it("a. inventorySetQuantities with K1, 0 → 5, applies", async () => {
        const a = await set(0, 5);
        firstGroup = a.group;
        const q = await available();
        const pass = !a.errors?.length && !a.userErrors.length && q === 5;
        report("a. set 0→5 with K1", pass, `available now ${q}`, { key: k1, ...a, available: q });
        expect(pass).toBe(true);
    });

    it("b. the identical request with K1 returns the original result and is not applied twice", async () => {
        // changeFromQuantity 0 against available 5: a replay Shopify did not dedupe answers CHANGE_FROM_QUANTITY_STALE.
        const b = await set(0, 5);
        const q = await available();
        const pass = !b.errors?.length && !b.userErrors.length && b.group === firstGroup && q === 5;
        report("b. identical replay with K1", pass, pass ? "original result returned, available still 5" : `key NOT honoured as a replay (available ${q})`,
            { key: k1, ...b, firstGroup, available: q });
        expect(pass).toBe(true);
    });

    it("c. K1 reused with a different quantity (7) is refused", async () => {
        const c = await set(0, 7);
        const q = await available();
        const refused = !!c.errors?.length || c.userErrors.length > 0;
        report("c. K1 reused with quantity 7", refused && q === 5, refused ? `refused, available ${q}` : `ACCEPTED a different request under K1 (available ${q})`,
            { key: k1, ...c, available: q });
        expect(refused && q === 5).toBe(true);
    });
});
