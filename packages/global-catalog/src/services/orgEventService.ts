import { Prisma } from "../generated/prisma/client";
import { db } from "../db";
import { createOrgEventRepository } from "../repositories/orgEvent";
import type { WorkflowType } from "../db/schema";
import { orgEventPayloadSchema, type OrgEventPayload } from "../types/orgEvents";

type Tx = Prisma.TransactionClient;

const orgEventRepo = createOrgEventRepository(db);

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
  await orgEventRepo.emitOrgEvent(tx, orgId, validated);
}

