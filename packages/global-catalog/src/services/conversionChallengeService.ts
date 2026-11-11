import { db } from "../db";
import { createConversionChallengeRepository } from "../repositories/conversionChallenge";
import { createItemReferenceRepository } from "../repositories/itemReference";
import type { Prisma } from "../generated/prisma/client";
import type { ConversionChallenge, ConversionChallengeStatus } from "../db/schema";

const challengeRepo = createConversionChallengeRepository(db);
const itemRefRepo = createItemReferenceRepository(db);
import { ServiceError } from "@checkin/component-kit";
import { reviewTransitionError } from "./categoryService";
import { assertConversionChallengeTransition } from "../workflows/conversion-challenge.machine";
import { emitOrgEvent, recordTransition, transactionWithEvents } from "./orgEventService";

const ALREADY_REVIEWED = "Challenge was already reviewed";

export interface SubmitChallengeParams {
  orgId: string;
  orgName: string;
  localUserId: number;
  itemReferenceId: number;
  proposedFactor: number;
  reason: string;
}

/** Serializes one org's pending-challenge check and create on one reference. */
export async function lockChallengeSubmission(tx: Prisma.TransactionClient, itemReferenceId: number, orgId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`conversion-challenge:${itemReferenceId}:${orgId}`}, 0))`;
}

export async function submitChallenge(params: SubmitChallengeParams): Promise<ConversionChallenge> {
  if (params.proposedFactor <= 0) throw new ServiceError(400, "proposedFactor must be greater than 0");

  const ref = await itemRefRepo.findById(params.itemReferenceId);
  if (!ref) throw new ServiceError(404, "Item reference not found");

  return db.$transaction(async (tx) => {
    await lockChallengeSubmission(tx, params.itemReferenceId, params.orgId);
    const repo = createConversionChallengeRepository(tx);

    const existing = await repo.findPendingByReferenceAndOrg(params.itemReferenceId, params.orgId);
    if (existing) throw new ServiceError(409, "A pending challenge already exists for this reference from your organization");

    return repo.create({
      itemReferenceId: params.itemReferenceId,
      localUserId: params.localUserId,
      orgId: params.orgId,
      orgName: params.orgName,
      currentFactor: ref.conversionFactor,
      proposedFactor: params.proposedFactor,
      reason: params.reason.trim(),
      status: "pending",
    });
  });
}

export async function acceptChallenge(challengeId: number, userId: number): Promise<void> {
  const challenge = await challengeRepo.findById(challengeId);
  if (!challenge) throw new ServiceError(404, "Challenge not found");
  let acceptedStatus: ConversionChallengeStatus;
  try {
    acceptedStatus = assertConversionChallengeTransition(challenge.status as ConversionChallengeStatus, "ACCEPT");
  } catch (err) {
    throw reviewTransitionError(err, challenge.status !== "pending", ALREADY_REVIEWED);
  }

  const ref = await itemRefRepo.findById(challenge.itemReferenceId);
  if (!ref) throw new ServiceError(404, "Item reference not found");

  await transactionWithEvents(async (tx) => {
    const { count } = await tx.conversionChallenge.updateMany({
      where: { id: challengeId, status: challenge.status },
      data: { status: acceptedStatus, reviewedByUserId: userId, reviewedAt: new Date() },
    });
    if (count === 0) throw new ServiceError(409, ALREADY_REVIEWED);

    // The reviewer decided on currentFactor, and the event publishes it as previousFactor.
    const moved = await tx.itemReference.updateMany({
      where: { id: challenge.itemReferenceId, conversionFactor: challenge.currentFactor },
      data: { conversionFactor: challenge.proposedFactor, conversionVersion: { increment: 1 } },
    });
    if (moved.count === 0) throw new ServiceError(409, "The reference's factor changed after this challenge was submitted");
    const { conversionVersion: newVersion } = await tx.itemReference.findUniqueOrThrow({
      where: { id: challenge.itemReferenceId },
      select: { conversionVersion: true },
    });

    await recordTransition(tx, "conversion_challenge", challengeId, challenge.status, acceptedStatus, userId);
    await emitOrgEvent(tx, challenge.orgId, {
      eventType: "conversion_challenge_accepted",
      version: 1,
      challengeId,
      itemReferenceId: challenge.itemReferenceId,
      previousFactor: challenge.currentFactor,
      acceptedFactor: challenge.proposedFactor,
      conversionVersion: newVersion,
    });
  });
}

export async function rejectChallenge(challengeId: number, userId: number): Promise<void> {
  const challenge = await challengeRepo.findById(challengeId);
  if (!challenge) throw new ServiceError(404, "Challenge not found");
  let rejectedStatus: ConversionChallengeStatus;
  try {
    rejectedStatus = assertConversionChallengeTransition(challenge.status as ConversionChallengeStatus, "REJECT");
  } catch (err) {
    throw reviewTransitionError(err, challenge.status !== "pending", ALREADY_REVIEWED);
  }

  await transactionWithEvents(async (tx) => {
    const { count } = await tx.conversionChallenge.updateMany({
      where: { id: challengeId, status: challenge.status },
      data: { status: rejectedStatus, reviewedByUserId: userId, reviewedAt: new Date() },
    });
    if (count === 0) throw new ServiceError(409, ALREADY_REVIEWED);

    await recordTransition(tx, "conversion_challenge", challengeId, challenge.status, rejectedStatus, userId);
    await emitOrgEvent(tx, challenge.orgId, {
      eventType: "conversion_challenge_rejected",
      version: 1,
      challengeId,
      itemReferenceId: challenge.itemReferenceId,
      proposedFactor: challenge.proposedFactor,
    });
  });
}
