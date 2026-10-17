/**
 * Configuration / credential loading.
 *
 * Reads from process.env. Locally these come from a git-ignored `.env`
 * (loaded via `node --env-file=.env ...` in the npm scripts). In Lambda the
 * same variables are injected by the execution environment from the secret
 * store (Secrets Manager / SSM) — the code does not care which.
 *
 * Split into two loaders so the loader/inject path needs only the database and
 * never requires Shopify credentials to be present.
 */
import { z } from "zod";

/** The production Shopify store. Test fixtures must never be injected against it. */
export const PROD_STORE_DOMAIN = "9jhydb-ka.myshopify.com";

const dbSchema = z.object({
  SHOPIFY_READ_DATABASE_URL: z.string().min(1, "SHOPIFY_READ_DATABASE_URL is required"),
  STORE_ID: z.string().min(1).optional(),
});

const shopifySchema = z
  .object({
    SHOPIFY_SHOP: z.string().min(1, "SHOPIFY_SHOP is required"),
    // Static token (local dev / legacy custom apps) OR client-credentials (deployed
    // Lambda, minted at runtime — see s-read-function/src/shopify/token.ts). At least
    // one of the two must be present; enforced below since Zod's object schema can't
    // express "A or (B and C)" declaratively.
    SHOPIFY_ADMIN_TOKEN: z.string().min(1).optional(),
    SHOPIFY_CLIENT_ID: z.string().min(1).optional(),
    SHOPIFY_CLIENT_SECRET: z.string().min(1).optional(),
    SHOPIFY_API_VERSION: z.string().min(1).default("2025-07"),
    CUTOVER_DATE: z.string().min(1, "CUTOVER_DATE is required"),
  })
  .refine((v) => Boolean(v.SHOPIFY_ADMIN_TOKEN) || Boolean(v.SHOPIFY_CLIENT_ID && v.SHOPIFY_CLIENT_SECRET), {
    message: "Set SHOPIFY_ADMIN_TOKEN (local/legacy), or both SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (deployed).",
  });

export interface DbConfig {
  databaseUrl: string;
  /**
   * Store id used ONLY by the offline inject path (which has no Shopify creds).
   * Real syncs ignore this and derive store_id from the live store's myshopifyDomain
   * via ensureStore(); if this disagrees with the API, ensureStore logs a warning.
   * Defaults to SHOPIFY_SHOP or "default".
   */
  storeId: string;
}

export interface ShopifyConfig {
  shop: string;
  /**
   * Static Admin API token (local dev / legacy custom apps). When present it's used
   * verbatim forever — takes precedence over clientId/clientSecret, never minted or cached.
   */
  adminToken?: string;
  /** Client-credentials grant identity, used to mint a short-lived (~24h) token when adminToken is absent. */
  clientId?: string;
  clientSecret?: string;
  apiVersion: string;
  cutoverDate: string;
  /** GraphQL endpoint derived from shop + apiVersion. */
  endpoint: string;
}

export function loadDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const parsed = dbSchema.parse(env);
  return {
    databaseUrl: parsed.SHOPIFY_READ_DATABASE_URL,
    storeId: parsed.STORE_ID ?? env.SHOPIFY_SHOP ?? "default",
  };
}

export function loadShopifyConfig(env: NodeJS.ProcessEnv = process.env): ShopifyConfig {
  const parsed = shopifySchema.parse(env);
  const shop = parsed.SHOPIFY_SHOP;
  return {
    shop,
    adminToken: parsed.SHOPIFY_ADMIN_TOKEN,
    clientId: parsed.SHOPIFY_CLIENT_ID,
    clientSecret: parsed.SHOPIFY_CLIENT_SECRET,
    apiVersion: parsed.SHOPIFY_API_VERSION,
    cutoverDate: parsed.CUTOVER_DATE,
    endpoint: `https://${shop}/admin/api/${parsed.SHOPIFY_API_VERSION}/graphql.json`,
  };
}
