/**
 * Ingest one node: append it to the append-only log (its own commit, so it is
 * durable and replayable even if projection later fails), then project it into
 * the live tables in a single transaction.
 */
import type { PrismaClient } from "../db/client.js";
import { EventSource, ObjectType } from "../generated/prisma/client.js";
import { appendRawEvent } from "./rawLog.js";
import { projectNode } from "../loader/index.js";
import { logger } from "../logger.js";

export interface IngestNodeArgs {
  storeId: string;
  objectType: ObjectType;
  node: unknown;
  source: EventSource;
  syncRunId?: bigint | null;
}

export interface IngestNodeResult {
  rawEventId: bigint;
  shopifyGid: string;
  occurredAt: Date | null;
  inserted: boolean;
}

export async function ingestNode(prisma: PrismaClient, args: IngestNodeArgs): Promise<IngestNodeResult> {
  // 1. Durable raw log first — never lost even if projection throws.
  const raw = await appendRawEvent(prisma, args);

  // 2. Project into live tables atomically.
  try {
    await prisma.$transaction((tx) => projectNode(tx, args.storeId, args.objectType, args.node, args.source));
  } catch (err) {
    logger.error("projection failed; raw event retained for replay", {
      rawEventId: raw.rawEventId.toString(),
      shopifyGid: raw.shopifyGid,
      objectType: args.objectType,
      err,
    });
    throw err;
  }

  return raw;
}
