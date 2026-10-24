/**
 * Resolve the authoritative store identity from the Shopify API and record it in
 * the `store` registry. The returned `storeId` (the permanent myshopifyDomain) is
 * what gets stamped on every row — derived from the live store, never trusted from
 * config. This is the single source of truth for "which store" a sync belongs to.
 */
import { type PrismaClient, legacyIdFromGid, logger } from "@checkin/s-ingest-core";
import type { ShopifyClient } from "../shopify/client.js";
import { SHOP_IDENTITY_QUERY } from "../shopify/queries.js";

export interface StoreIdentity {
  storeId: string; // myshopifyDomain — the canonical store_id stamped on rows
  shopGid: string;
  numericId: string;
  name: string | null;
}

export async function resolveStoreIdentity(client: ShopifyClient): Promise<StoreIdentity> {
  const data = await client.request<{
    shop: { id: string; myshopifyDomain: string; name?: string | null };
  }>(SHOP_IDENTITY_QUERY);
  const shop = data.shop;
  return {
    storeId: shop.myshopifyDomain,
    shopGid: shop.id,
    // Shop has no legacyResourceId field (see SHOP_IDENTITY_QUERY) — the
    // numeric id comes from the gid's last path segment.
    numericId: legacyIdFromGid(shop.id) ?? "",
    name: shop.name ?? null,
  };
}

/**
 * Resolve identity from the API, upsert the `store` registry row, and return the
 * canonical storeId. Warns (non-fatally) if a configured STORE_ID disagrees with
 * what the live store reports.
 */
export async function ensureStore(
  prisma: PrismaClient,
  client: ShopifyClient,
  configuredStoreId?: string,
): Promise<StoreIdentity> {
  const identity = await resolveStoreIdentity(client);

  if (configuredStoreId && configuredStoreId !== identity.storeId) {
    logger.warn("configured STORE_ID does not match the live store; using the API value", {
      configured: configuredStoreId,
      resolved: identity.storeId,
    });
  }

  await prisma.store.upsert({
    where: { myshopifyDomain: identity.storeId },
    create: { myshopifyDomain: identity.storeId, shopGid: identity.shopGid, numericId: identity.numericId, name: identity.name },
    update: { shopGid: identity.shopGid, numericId: identity.numericId, name: identity.name },
  });

  return identity;
}
