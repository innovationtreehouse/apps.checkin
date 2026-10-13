/**
 * Inject a hand-authored / fixture node into the system. Validates with the same
 * Zod schemas the API path uses, logs it tagged HAND_LOADED (or TEST_LOADED), then
 * projects it into the live tables — identical to a real API ingest, but auditable
 * via the raw log's `source` column. Used by the `inject` CLI command and by test
 * / batch infrastructure to seed matching raw events without calling Shopify.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { PrismaClient } from "../db/client.js";
import { EventSource, ObjectType } from "../generated/prisma/client.js";
import { ingestNode, type IngestNodeResult } from "./ingestNode.js";
import { rawMetaForNode } from "../shopify/schemas.js";

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
}

/** A TEST_LOADED order must carry Shopify's own test flag, which every downstream reader filters on. */
function asTestNode(objectType: ObjectType, node: unknown): unknown {
  if (objectType !== ObjectType.ORDER || typeof node !== "object" || node === null) return node;
  return { ...node, test: true };
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
 * Inject one or many fixtures already parsed into objects. Refuses the whole batch,
 * before writing anything, if any fixture reuses the GID of an API-owned row.
 */
export async function injectFixtures(
  prisma: PrismaClient,
  fixtures: Array<{ objectType: ObjectType; node: unknown }>,
  opts: InjectOptions,
): Promise<IngestNodeResult[]> {
  const taken = await apiOwnedGids(prisma, opts.storeId, fixtures);
  if (taken.length > 0) {
    throw new Error(`inject refused: ${taken.length} GID(s) already hold API-synced rows: ${taken.join(", ")}`);
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
