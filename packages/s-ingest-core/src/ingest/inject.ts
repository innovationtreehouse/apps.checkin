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

/** Inject one or many fixtures already parsed into objects. */
export async function injectFixtures(
  prisma: PrismaClient,
  fixtures: Array<{ objectType: ObjectType; node: unknown }>,
  opts: InjectOptions,
): Promise<IngestNodeResult[]> {
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
