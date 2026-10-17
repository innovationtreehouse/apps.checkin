import { Prisma } from "../generated/prisma/client";
import { db } from "../db";
import { createOrgEventRepository } from "../repositories/orgEvent";
import type { WorkflowType } from "../db/schema";
import type { OrgEventRecord } from "../contract";
import { getOrgEventConsumers } from "../runtime";
import { orgEventPayloadSchema, type OrgEventPayload } from "../types/orgEvents";

type Tx = Prisma.TransactionClient;

const orgEventRepo = createOrgEventRepository(db);

/** Events written inside a transaction, handed to the consumers once it commits. */
const emittedByTx = new WeakMap<Tx, OrgEventRecord[]>();

export async function recordTransition(
  tx: Tx,
  workflowType: WorkflowType,
  recordId: number,
  fromStatus: string,
  toStatus: string,
  transitionedByUserId: number | null,
  note?: string
): Promise<void> {
  await orgEventRepo.recordTransition(tx, workflowType, recordId, fromStatus, toStatus, transitionedByUserId, note);
}

export async function emitOrgEvent(
  tx: Tx,
  orgId: string,
  payload: OrgEventPayload
): Promise<void> {
  // Validate against the shared S5 contract at the source: a malformed event
  // fails inside the emitting transaction instead of silently reaching every
  // consumer. TypeScript already constrains the type; this guards casts/`any`.
  const validated = orgEventPayloadSchema.parse(payload);
  const row = await orgEventRepo.emitOrgEvent(tx, orgId, validated);
  emittedByTx.set(tx, [...(emittedByTx.get(tx) ?? []), row]);
}

/**
 * Run `fn` in a catalog transaction, then hand the events it emitted to every registered
 * consumer in-process. The commit stands whether or not a consumer succeeds: a consumer that
 * throws is logged and catches up from its own cursor.
 */
export async function transactionWithEvents<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let emitted: OrgEventRecord[] = [];
  const result = await db.$transaction(async (tx) => {
    const value = await fn(tx);
    emitted = emittedByTx.get(tx) ?? [];
    return value;
  });
  await publishOrgEvents(emitted);
  return result;
}

async function publishOrgEvents(events: OrgEventRecord[]): Promise<void> {
  if (events.length === 0) return;
  for (const [name, consumer] of Object.entries(getOrgEventConsumers())) {
    try {
      await consumer.onOrgEvents(events);
    } catch (err) {
      console.error(`[global-catalog/org-events] consumer ${name} failed; it replays from its cursor`, err);
    }
  }
}

/** Replay read: the org's events with id greater than `afterId`, oldest first. */
export async function eventsSince(orgId: string, afterId: number, limit = 500): Promise<OrgEventRecord[]> {
  return orgEventRepo.listOrgEvents(orgId, afterId, limit);
}
