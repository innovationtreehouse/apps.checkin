/**
 * Shared plumbing for the Shopify LIVE contract suite (see
 * docs/ops/shopify-live-tests.md). These tests run the app's REAL
 * lib/shopify.ts functions against the REAL dev store — no fetch mocks — to
 * catch Admin-API contract drift that mocked tests structurally cannot.
 *
 * Every suite must call ensureLiveStore() in beforeAll (dev-store-only guard)
 * and register created resources with track*() so afterAll + the janitor can
 * clean up even after a mid-test crash.
 */
import { assertLiveTestStore, CITEST_PREFIX } from "./guard";
import { getAccessToken, shopifyFetch, SHOPIFY_API_VERSION } from "@/lib/shopify";

export function ensureLiveStore(): string {
    return assertLiveTestStore(process.env);
}

/** Unique, janitor-recognizable name for this run's resources. */
export function testRunName(suite: string): string {
    return `${CITEST_PREFIX}${suite}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function authHeaders(): Promise<Record<string, string>> {
    const token = await getAccessToken();
    if (!token) throw new Error("shopify-live: could not mint an Admin API token — check dev credentials");
    return { "Content-Type": "application/json", "X-Shopify-Access-Token": token };
}

export function adminUrl(path: string): string {
    const domain = process.env.SHOPIFY_STORE_DOMAIN;
    return `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/${path}`;
}

/** GET an Admin resource, throwing on non-2xx with the body in the message. */
export async function adminGet<T>(path: string): Promise<T> {
    const res = await shopifyFetch(adminUrl(path), { headers: await authHeaders() }, `live GET ${path}`);
    if (!res.ok) throw new Error(`live GET ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
}

/** POST a GraphQL query/mutation, throwing on transport or GraphQL-level errors. */
export async function adminGraphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await shopifyFetch(adminUrl("graphql.json"), {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ query, variables }),
    }, "live GraphQL");
    if (!res.ok) throw new Error(`live GraphQL -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { data?: T; errors?: unknown[] };
    if (data.errors?.length) throw new Error(`live GraphQL errors: ${JSON.stringify(data.errors).slice(0, 300)}`);
    return data.data as T;
}

/** DELETE an Admin resource; 404 counts as already-gone (idempotent cleanup). */
export async function adminDelete(path: string): Promise<void> {
    const res = await shopifyFetch(adminUrl(path), { method: "DELETE", headers: await authHeaders() }, `live DELETE ${path}`);
    if (!res.ok && res.status !== 404) {
        throw new Error(`live DELETE ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
}

// ── Cleanup registry: everything created gets registered the moment its id is
// known, so afterAll deletes it even when a later assertion throws. ──────────
const createdProductIds: string[] = [];
const createdPriceRuleIds: string[] = [];
const createdDiscountIds: string[] = []; // DiscountCodeNode gids (GraphQL discounts)

export function trackProduct(id: string | number | null | undefined): void {
    if (id) createdProductIds.push(String(id));
}
export function trackPriceRule(id: string | number | null | undefined): void {
    if (id) createdPriceRuleIds.push(String(id));
}

export function trackDiscount(id: string | null | undefined): void {
    if (id) createdDiscountIds.push(id);
}

export async function cleanupTracked(): Promise<void> {
    for (const id of createdDiscountIds.splice(0)) {
        await adminGraphql(
            `mutation($id: ID!) { discountCodeDelete(id: $id) { deletedCodeDiscountId userErrors { message } } }`,
            { id },
        ).catch((e) => console.error("cleanup discount", id, e));
    }
    for (const id of createdPriceRuleIds.splice(0)) {
        await adminDelete(`price_rules/${id}.json`).catch((e) => console.error("cleanup price_rule", id, e));
    }
    for (const id of createdProductIds.splice(0)) {
        await adminDelete(`products/${id}.json`).catch((e) => console.error("cleanup product", id, e));
    }
}

// ── Typed slices of the Admin responses the assertions read. ────────────────
export interface AdminVariant {
    id: number;
    product_id: number;
    price: string;
    inventory_item_id: number;
    inventory_management: string | null;
    inventory_policy: string;
}

export async function getVariant(variantId: string): Promise<AdminVariant> {
    const data = await adminGet<{ variant: AdminVariant }>(`variants/${variantId}.json`);
    return data.variant;
}

export async function getAvailable(inventoryItemId: number): Promise<number> {
    const data = await adminGet<{ inventory_levels: { available: number }[] }>(
        `inventory_levels.json?inventory_item_ids=${inventoryItemId}`,
    );
    if (data.inventory_levels.length === 0) throw new Error("no inventory level rows for item");
    return data.inventory_levels.reduce((sum, l) => sum + (l.available ?? 0), 0);
}

export interface AdminPriceRule {
    id: number;
    title: string;
    value_type: string;
    value: string;
    allocation_method: string;
    target_type: string;
    target_selection: string;
    entitled_variant_ids: number[];
    usage_limit: number | null;
    once_per_customer: boolean;
    starts_at: string;
    ends_at: string | null;
}

/** Find the price rule mintMemberDiscountCode created — its title IS the code. */
export async function findPriceRuleByTitle(title: string): Promise<AdminPriceRule | null> {
    const data = await adminGet<{ price_rules: AdminPriceRule[] }>(`price_rules.json?limit=250`);
    return data.price_rules.find((r) => r.title === title) ?? null;
}


// ── GraphQL discount lookup (the member-discount mint is GraphQL-native). ───
export interface LiveDiscountBasic {
    id: string;
    title: string;
    usageLimit: number | null;
    appliesOncePerCustomer: boolean;
    startsAt: string;
    endsAt: string | null;
    amount: string;
    appliesOnEachItem: boolean;
    variantGids: string[];
}

/** Fetch the stored discount for a code, or null when Shopify has no such code. */
export async function findDiscountByCode(code: string): Promise<LiveDiscountBasic | null> {
    const data = await adminGraphql<{
        codeDiscountNodeByCode: {
            id: string;
            codeDiscount: {
                __typename: string;
                title: string;
                usageLimit: number | null;
                appliesOncePerCustomer: boolean;
                startsAt: string;
                endsAt: string | null;
                customerGets: {
                    value: { __typename: string; amount?: { amount: string }; appliesOnEachItem?: boolean };
                    items: { __typename: string; productVariants?: { nodes: { id: string }[] } };
                };
            };
        } | null;
    }>(
        `query($code: String!) {
            codeDiscountNodeByCode(code: $code) {
                id
                codeDiscount {
                    __typename
                    ... on DiscountCodeBasic {
                        title usageLimit appliesOncePerCustomer startsAt endsAt
                        customerGets {
                            value { __typename ... on DiscountAmount { amount { amount } appliesOnEachItem } }
                            items { __typename ... on DiscountProducts { productVariants(first: 10) { nodes { id } } } }
                        }
                    }
                }
            }
        }`,
        { code },
    );
    const node = data.codeDiscountNodeByCode;
    if (!node) return null;
    const d = node.codeDiscount;
    return {
        id: node.id,
        title: d.title,
        usageLimit: d.usageLimit,
        appliesOncePerCustomer: d.appliesOncePerCustomer,
        startsAt: d.startsAt,
        endsAt: d.endsAt,
        amount: d.customerGets.value.amount?.amount ?? "",
        appliesOnEachItem: d.customerGets.value.appliesOnEachItem ?? false,
        variantGids: d.customerGets.items.productVariants?.nodes.map((n) => n.id) ?? [],
    };
}
