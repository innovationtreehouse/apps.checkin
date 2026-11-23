/**
 * Inject a hand-authored / fixture node into the system. Validates with the same
 * Zod schemas the API path uses, logs it tagged HAND_LOADED (or TEST_LOADED), then
 * projects it into the live tables — identical to a real API ingest, but auditable
 * via the raw log's `source` column. Used by the `inject` CLI command and by test
 * / batch infrastructure to seed matching raw events without calling Shopify. Single
 * loads run in dev and staging only; the production copy accepts only a historic load.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { PrismaClient } from "../db/client.js";
import { EventSource, ObjectType } from "../generated/prisma/client.js";
import { ingestNode, type IngestNodeResult } from "./ingestNode.js";
import { rawMetaForNode } from "../shopify/schemas.js";
import { PROD_STORE_DOMAIN } from "../config.js";

// Prisma enum values are exactly these strings (ObjectType.ORDER === "ORDER"),
// so validate the literal and cast — version-independent across Zod releases.
const fixtureSchema = z.object({
  objectType: z.enum(["ORDER", "PAYOUT", "BALANCE_TXN", "REFUND"]),
  node: z.unknown(),
});
const fixtureFileSchema = z.union([fixtureSchema, z.array(fixtureSchema)]);

export interface InjectOptions {
  storeId: string;
  /** When true, tag rows TEST_LOADED instead of HAND_LOADED and force orders' `test` flag on. */
  test?: boolean;
  /** The ADMIN sync_run recording who injected and why. */
  syncRunId?: bigint | null;
  /**
   * Historic mode: the one-time bulk load of pre-cutover exports, the only inject the
   * production copy accepts. Every record must be dated before this instant.
   */
  historicCutover?: Date;
}

/** A TEST_LOADED order must carry Shopify's own test flag, which every downstream reader filters on. */
function asTestNode(objectType: ObjectType, node: unknown): unknown {
  if (objectType !== ObjectType.ORDER || typeof node !== "object" || node === null) return node;
  return { ...node, test: true };
}

async function isProductionCopy(prisma: PrismaClient, storeId: string): Promise<boolean> {
  if (storeId === PROD_STORE_DOMAIN) return true;
  const prodHere = await prisma.store.findUnique({
    where: { myshopifyDomain: PROD_STORE_DOMAIN },
    select: { myshopifyDomain: true },
  });
  return prodHere !== null;
}

/**
 * Single loads are a dev and staging tool. The production copy, by the target store or by
 * the production store's registry row in this database, accepts only a historic load.
 */
async function assertModeAllowed(prisma: PrismaClient, opts: InjectOptions): Promise<void> {
  if (opts.historicCutover && opts.test) {
    throw new Error("inject refused: a historic load cannot also be a test load");
  }
  if (!opts.historicCutover && (await isProductionCopy(prisma, opts.storeId))) {
    throw new Error("inject refused: hand-loading is not allowed into the production copy");
  }
}

/** Fixture GIDs that are undated or dated on or after the cutover. */
export function notBeforeCutoverGids(fixtures: Array<{ objectType: ObjectType; node: unknown }>, cutover: Date): string[] {
  return fixtures
    .map((f) => rawMetaForNode(f.objectType, f.node))
    .filter((m) => m.occurredAt === null || m.occurredAt >= cutover)
    .map((m) => m.shopifyGid);
}

/** An API-synced row (or one written before `source` existed) is Shopify's truth. */
const API_OWNED = { OR: [{ source: null }, { source: { in: [EventSource.BACKFILL, EventSource.INCREMENTAL] } }] };

/**
 * Fixture GIDs that already have an API-owned live row. Projection upserts by GID, so
 * injecting one would overwrite real data — and orders are newest-wins on `updatedAt`, so
 * a fixture stamped later than Shopify's copy would pin itself there. shop_refund has no
 * `source`, so any existing refund row counts as API-owned.
 */
async function apiOwnedGids(
  prisma: PrismaClient,
  storeId: string,
  fixtures: Array<{ objectType: ObjectType; node: unknown }>,
): Promise<string[]> {
  const gids = (t: ObjectType) =>
    fixtures.filter((f) => f.objectType === t).map((f) => rawMetaForNode(t, f.node).shopifyGid);
  const [orders, payouts, txns, refunds] = await Promise.all([
    prisma.shopOrder.findMany({
      where: { storeId, shopifyGid: { in: gids(ObjectType.ORDER) }, ...API_OWNED },
      select: { shopifyGid: true },
    }),
    prisma.shopPayout.findMany({
      where: { storeId, payoutGid: { in: gids(ObjectType.PAYOUT) }, ...API_OWNED },
      select: { payoutGid: true },
    }),
    prisma.shopBalanceTransaction.findMany({
      where: { storeId, txnGid: { in: gids(ObjectType.BALANCE_TXN) }, ...API_OWNED },
      select: { txnGid: true },
    }),
    prisma.shopRefund.findMany({
      where: { storeId, refundGid: { in: gids(ObjectType.REFUND) } },
      select: { refundGid: true },
    }),
  ]);
  return [
    ...orders.map((r) => r.shopifyGid),
    ...payouts.map((r) => r.payoutGid),
    ...txns.map((r) => r.txnGid),
    ...refunds.map((r) => r.refundGid),
  ];
}

/**
 * Fixture GIDs stamped later than `now`. Orders are newest-wins on `updatedAt`, so a
 * future-stamped row would block every real update and replay of that GID.
 */
export function futureStampedGids(fixtures: Array<{ objectType: ObjectType; node: unknown }>, now: Date): string[] {
  return fixtures
    .map((f) => rawMetaForNode(f.objectType, f.node))
    .filter((m) => m.occurredAt !== null && m.occurredAt > now)
    .map((m) => m.shopifyGid);
}

/**
 * Inject one or many fixtures already parsed into objects. Refuses the whole batch,
 * before writing anything, when the mode is not allowed for the target, when a historic
 * load holds a record not dated before the cutover, or when any fixture reuses the GID
 * of an API-owned row or is stamped in the future.
 */
export async function injectFixtures(
  prisma: PrismaClient,
  fixtures: Array<{ objectType: ObjectType; node: unknown }>,
  opts: InjectOptions,
): Promise<IngestNodeResult[]> {
  await assertModeAllowed(prisma, opts);
  if (opts.historicCutover) {
    const late = notBeforeCutoverGids(fixtures, opts.historicCutover);
    if (late.length > 0) {
      throw new Error(
        `inject refused: ${late.length} GID(s) are not dated before the cutover ${opts.historicCutover.toISOString()}: ${late.join(", ")}`,
      );
    }
  }
  const taken = await apiOwnedGids(prisma, opts.storeId, fixtures);
  if (taken.length > 0) {
    throw new Error(`inject refused: ${taken.length} GID(s) already hold API-synced rows: ${taken.join(", ")}`);
  }
  const future = futureStampedGids(fixtures, new Date());
  if (future.length > 0) {
    throw new Error(`inject refused: ${future.length} GID(s) are stamped in the future: ${future.join(", ")}`);
  }
  const source = opts.test ? EventSource.TEST_LOADED : EventSource.HAND_LOADED;
  const results: IngestNodeResult[] = [];
  for (const f of fixtures) {
    const node = opts.test ? asTestNode(f.objectType, f.node) : f.node;
    results.push(
      await ingestNode(prisma, {
        storeId: opts.storeId,
        objectType: f.objectType,
        node,
        source,
        syncRunId: opts.syncRunId,
      }),
    );
  }
  return results;
}

/** Read a fixture JSON file and inject its contents. */
export async function injectFile(
  prisma: PrismaClient,
  filePath: string,
  opts: InjectOptions,
): Promise<IngestNodeResult[]> {
  const raw = await readFile(filePath, "utf8");
  const parsed = fixtureFileSchema.parse(JSON.parse(raw));
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const fixtures = list.map((f) => ({ objectType: f.objectType as ObjectType, node: f.node }));
  return injectFixtures(prisma, fixtures, opts);
}
