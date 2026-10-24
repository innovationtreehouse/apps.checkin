/**
 * @jest-environment node
 */
/**
 * LIVE contract: a resend of the inventory mutations the program-stock writer
 * (#2055) sends under `@idempotent(key:)` never writes twice — Admin API 2026-04,
 * same mutation shapes. Whether the key itself was honoured is logged, not asserted. Each check logs one `[idempotency] <check>: PASS|FAIL|INFO` line plus the
 * raw response fields, so the result reads straight off the workflow log.
 *
 * d runs first: the item must be stocked at the location before a–c can set it.
 */
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/email", () => ({ sendEmail: jest.fn() }));

import crypto from "crypto";
import { getAccessToken, shopifyFetch } from "@/lib/shopify/client";
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

/** What refused a set: the idempotency key, the compare-and-set, something else, or null when it was accepted. */
function refusedBy(r: { errors?: unknown[]; userErrors: UserError[] }): string | null {
    const codes = r.userErrors.map((e) => e.code ?? "");
    if (r.errors?.length || codes.some((c) => c.startsWith("IDEMPOTENCY"))) return "the key";
    if (codes.includes("CHANGE_FROM_QUANTITY_STALE")) return "CHANGE_FROM_QUANTITY_STALE (not the key)";
    return codes.length ? `userErrors ${codes.join(",")}` : null;
}

const ADJUST_STOCK = `
    mutation ProbeAdjust($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
        inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
            inventoryAdjustmentGroup { id }
            userErrors { code field message }
        }
    }`;

function report(check: string, outcome: "PASS" | "FAIL" | "INFO", note: string, raw: unknown): void {
    // Straight to stdout: jest's console capture buries console.log under stack frames.
    process.stdout.write(`\n[idempotency] ${check}: ${outcome} — ${note}\n${JSON.stringify(raw, null, 2)}\n`);
}
const passFail = (pass: boolean) => (pass ? "PASS" : "FAIL");

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

    const setVars = (changeFromQuantity: number, quantity: number, key: string) => ({
        input: { name: "available", reason: "correction", quantities: [{ inventoryItemId: itemId, locationId, quantity, changeFromQuantity }] },
        idempotencyKey: key,
    });

    async function set(changeFromQuantity: number, quantity: number, key = k1) {
        const r = await gql(SET_STOCK, setVars(changeFromQuantity, quantity, key));
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
            report("d. inventoryActivate keyed x2", "FAIL", "API REJECTED @idempotent on inventoryActivate — #2055's activate call would fail", first);
            await gqlOk(ACTIVATE_PLAIN, { inventoryItemId: itemId, locationId }, "inventoryActivate");
            throw new Error("inventoryActivate rejected the idempotency key");
        }
        const second = await gql(ACTIVATE_KEYED, vars);
        const secondPayload = second.data?.inventoryActivate as ActivatePayload;
        const levels = await levelsAt();
        const quantity = levels[0]?.quantities[0]?.quantity ?? null;
        const pass = !firstPayload.userErrors.length && !second.errors?.length && !!secondPayload && !secondPayload.userErrors.length
            && secondPayload.inventoryLevel?.id === firstPayload.inventoryLevel?.id && levels.length === 1 && quantity === 0;
        report("d. inventoryActivate keyed x2", passFail(pass), pass ? "second call accepted, same level, one level, available 0" : "see raw fields",
            { key: vars.idempotencyKey, first: { status: first.status, payload: firstPayload }, second: { status: second.status, errors: second.errors, payload: secondPayload }, levelsAtLocation: levels.length, available: quantity });
        if (levels.length === 0) await gqlOk(ACTIVATE_PLAIN, { inventoryItemId: itemId, locationId }, "inventoryActivate");
        expect(pass).toBe(true);
    });

    it("a. inventorySetQuantities with K1, 0 → 5, applies", async () => {
        const a = await set(0, 5);
        firstGroup = a.group;
        const q = await available();
        const pass = !a.errors?.length && !a.userErrors.length && q === 5;
        report("a. set 0→5 with K1", passFail(pass), `available now ${q}`, { key: k1, ...a, available: q });
        expect(pass).toBe(true);
    });

    // The assertion is "no double write": the resend is deduped by the key or refused,
    // and available stays 5. Which of the two happened is logged as information only.
    it("b. the identical request with K1 is not applied twice", async () => {
        // changeFromQuantity 0 against available 5: a replay the key did not dedupe answers CHANGE_FROM_QUANTITY_STALE.
        const b = await set(0, 5);
        const q = await available();
        const deduped = !b.errors?.length && !b.userErrors.length && b.group === firstGroup;
        const pass = (deduped || refusedBy(b) !== null) && q === 5;
        report("b. identical replay with K1", passFail(pass), `${deduped ? "key honoured: original result returned" : `key NOT honoured; refused by ${refusedBy(b)}`}, available ${q}`,
            { key: k1, ...b, firstGroup, available: q });
        expect(pass).toBe(true);
    });

    it("c. K1 reused with a different quantity (7) is refused", async () => {
        const c = await set(0, 7);
        const q = await available();
        const by = refusedBy(c);
        report("c. K1 reused with quantity 7", passFail(by !== null && q === 5), by ? `refused by ${by}, available ${q}` : `ACCEPTED a different request under K1 (available ${q})`,
            { key: k1, ...c, available: q });
        expect(by !== null && q === 5).toBe(true);
    });

    // e and f isolate the key: neither resend can be refused by a stale compare.
    // INFO only — they report what the store did and never fail the suite.
    it("e. INFO: inventoryAdjustQuantities +1 with K2, sent twice", async () => {
        const k2 = `citest-adjust-${crypto.randomUUID()}`;
        const variables = {
            input: { name: "available", reason: "correction", changes: [{ inventoryItemId: itemId, locationId, delta: 1, changeFromQuantity: null }] },
            idempotencyKey: k2,
        };
        try {
            const before = await available();
            const first = await gql(ADJUST_STOCK, variables);
            const second = await gql(ADJUST_STOCK, variables);
            const after = await available();
            const change = before === null || after === null ? null : after - before;
            const verdict = change === 1 ? "key HONOURED (+1 total)" : change === 2 ? "key IGNORED (+2 total)" : `unexpected change ${change}`;
            report("e. adjust +1 x2 with K2", "INFO", `${verdict}; available ${before} → ${after}`,
                { request: { query: ADJUST_STOCK, variables }, first, second, before, after });
        } catch (err) {
            report("e. adjust +1 x2 with K2", "INFO", "probe errored", { error: String(err) });
        }
    });

    it("f. INFO: inventorySetQuantities current → current+1 with K3, sent twice", async () => {
        const k3 = `citest-set-${crypto.randomUUID()}`;
        try {
            const before = await available();
            if (before === null) throw new Error("no inventory level to read");
            const variables = setVars(before, before + 1, k3);
            const first = await set(before, before + 1, k3);
            const second = await set(before, before + 1, k3);
            const after = await available();
            const deduped = !second.errors?.length && !second.userErrors.length && second.group === first.group;
            const verdict = deduped ? "key HONOURED (first result returned)" : `key NOT honoured; second refused by ${refusedBy(second)}`;
            report("f. set current→+1 x2 with K3", "INFO", `${verdict}; available ${before} → ${after}`,
                { request: { query: SET_STOCK, variables }, first, second, before, after });
        } catch (err) {
            report("f. set current→+1 x2 with K3", "INFO", "probe errored", { error: String(err) });
        }
    });
});
