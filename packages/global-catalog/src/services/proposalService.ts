import { Prisma } from "../generated/prisma/client";
import { db } from "../db";
import { createProposalRepository } from "../repositories/proposal";
import { createCatalogRepository } from "../repositories/catalog";
import { createItemReferenceRepository } from "../repositories/itemReference";
import type { ItemReferenceProposal, ItemReferenceProposalStatus } from "../db/schema";

const proposalRepo = createProposalRepository(db);
const catalogRepo = createCatalogRepository(db);
const itemRefRepo = createItemReferenceRepository(db);
import { ServiceError } from "./categoryService";
import { assertItemReferenceProposalTransition } from "../workflows/item-reference-proposal.machine";
import { WorkflowTransitionError } from "@inventory/workflows";
import { normalizeDescription } from "../lib/normalizeDescription";
import { emitOrgEvent, recordTransition } from "./orgEventService";

export interface CreateItemReferenceProposalParams {
  gtin13: string;
  orgId: string;
  orgName: string;
  localUserId: number;
  partNumber?: string;
  description?: string;
  retailer?: string;
  manufacturer?: string;
  conversionFactor?: number;
}

export async function createItemReferenceProposal(
  params: CreateItemReferenceProposalParams
): Promise<ItemReferenceProposal> {
  const item = await catalogRepo.findItemByGtin13(params.gtin13);
  if (!item) throw new ServiceError(404, "Item not found");

  return proposalRepo.createItemReferenceProposal({
    gtin13: params.gtin13,
    orgId: params.orgId,
    orgName: params.orgName,
    localUserId: params.localUserId,
    partNumber: params.partNumber?.trim() || null,
    description: params.description?.trim() || null,
    retailer: params.retailer?.trim() || null,
    manufacturer: params.manufacturer?.trim() || null,
    conversionFactor: params.conversionFactor ?? 1.0,
    status: "pending",
  });
}

type MatchFields = Pick<ItemReferenceProposal, "partNumber" | "manufacturer" | "retailer" | "description">;

type CandidateSpec = {
  partNumber?: string;
  manufacturer?: string | null;
  retailer?: string;
  description?: string;
};

function getSupersessionCandidateSpecs(approved: MatchFields): CandidateSpec[] {
  const specs: CandidateSpec[] = [];

  if (approved.partNumber && approved.manufacturer && approved.retailer) {
    specs.push({ partNumber: approved.partNumber, manufacturer: approved.manufacturer });
    specs.push({ partNumber: approved.partNumber, retailer: approved.retailer, manufacturer: null });
  } else if (approved.partNumber && approved.manufacturer) {
    specs.push({ partNumber: approved.partNumber, manufacturer: approved.manufacturer });
  } else if (approved.partNumber && approved.retailer) {
    specs.push({ partNumber: approved.partNumber, retailer: approved.retailer });
  }

  if (approved.description && approved.manufacturer) {
    specs.push({ description: approved.description, manufacturer: approved.manufacturer });
  }

  return specs;
}

function specMatchesCandidate(spec: CandidateSpec, candidate: MatchFields): boolean {
  if (spec.partNumber !== undefined && candidate.partNumber !== spec.partNumber) return false;
  if (spec.manufacturer !== undefined && candidate.manufacturer !== spec.manufacturer) return false;
  if (spec.retailer !== undefined && candidate.retailer !== spec.retailer) return false;
  if (spec.description !== undefined && candidate.description !== spec.description) return false;
  return true;
}

export function proposalSupersedes(approved: MatchFields, candidate: MatchFields): boolean {
  return getSupersessionCandidateSpecs(approved).some((spec) => specMatchesCandidate(spec, candidate));
}

function specToPrismaClause(spec: CandidateSpec): Prisma.ItemReferenceProposalWhereInput {
  const clause: Prisma.ItemReferenceProposalWhereInput = {};
  if (spec.partNumber !== undefined) clause.partNumber = spec.partNumber;
  if (spec.manufacturer !== undefined) clause.manufacturer = spec.manufacturer ?? null;
  if (spec.retailer !== undefined) clause.retailer = spec.retailer;
  if (spec.description !== undefined) clause.description = spec.description;
  return clause;
}

export function buildSupersessionMatchClause(
  proposal: MatchFields
): Prisma.ItemReferenceProposalWhereInput | undefined {
  const clauses = getSupersessionCandidateSpecs(proposal).map(specToPrismaClause);
  return clauses.length > 0 ? { OR: clauses } : undefined;
}

export async function approveItemReferenceProposal(proposalId: number, userId: number, username?: string): Promise<void> {
  const proposal = await proposalRepo.findItemReferenceProposalById(proposalId);
  if (!proposal) throw new ServiceError(404, "Proposal not found");
  let approvedStatus: ItemReferenceProposalStatus;
  try {
    approvedStatus = assertItemReferenceProposalTransition(proposal.status as ItemReferenceProposalStatus, "APPROVE");
  } catch (err) {
    if (err instanceof WorkflowTransitionError) throw new ServiceError(400, err.message);
    throw err;
  }

  const matchClause = buildSupersessionMatchClause(proposal);
  const supersededWhere: Prisma.ItemReferenceProposalWhereInput | undefined = matchClause
    ? { status: "pending", id: { not: proposalId }, ...matchClause }
    : undefined;

  await db.$transaction(async (tx) => {
    const now = new Date();
    await tx.itemReference.create({
      data: {
        gtin13: proposal.gtin13,
        partNumber: proposal.partNumber,
        descriptionNormalized: proposal.description ? normalizeDescription(proposal.description) : null,
        retailer: proposal.retailer,
        manufacturer: proposal.manufacturer,
        conversionFactor: proposal.conversionFactor,
        createdByUserId: userId,
        updatedByUserId: userId,
        createdByUsername: username ?? null,
        updatedByUsername: username ?? null,
      },
    });

    const reviewedAt = new Date();
    await proposalRepo.updateItemReferenceProposal(tx, proposalId, { status: approvedStatus, reviewedByUserId: userId, reviewedAt });

    await recordTransition(tx, "item_reference_proposal", proposalId, proposal.status, approvedStatus, userId);
    await emitOrgEvent(tx, proposal.orgId, {
      eventType: "item_reference_proposal_approved",
      version: 1,
      proposalId,
      gtin13: proposal.gtin13,
      partNumber: proposal.partNumber,
      manufacturer: proposal.manufacturer,
      retailer: proposal.retailer,
    });

    if (supersededWhere) {
      const supersededStatus = assertItemReferenceProposalTransition("pending", "SUPERSEDE");
      const toSupersede = await proposalRepo.findManyItemReferenceProposalsToSupersede(tx, supersededWhere);
      if (toSupersede.length > 0) {
        await proposalRepo.updateManyItemReferenceProposals(tx, supersededWhere, {
          status: supersededStatus,
          reviewedByUserId: userId,
          reviewedAt,
          rejectionReason: `Superseded by approved proposal #${proposalId}`,
          supersededByProposalId: proposalId,
        });
        for (const row of toSupersede) {
          await recordTransition(tx, "item_reference_proposal", row.id, "pending", supersededStatus, userId, `Superseded by approved proposal #${proposalId}`);
          await emitOrgEvent(tx, row.orgId, {
            eventType: "item_reference_proposal_superseded",
            version: 1,
            proposalId: row.id,
            supersededByProposalId: proposalId,
          });
        }
      }
    }
  });
}

export async function rejectItemReferenceProposal(
  proposalId: number,
  userId: number,
  reason: string
): Promise<void> {
  const proposal = await proposalRepo.findItemReferenceProposalById(proposalId);
  if (!proposal) throw new ServiceError(404, "Proposal not found");
  let rejectedStatus: ItemReferenceProposalStatus;
  try {
    rejectedStatus = assertItemReferenceProposalTransition(proposal.status as ItemReferenceProposalStatus, "REJECT");
  } catch (err) {
    if (err instanceof WorkflowTransitionError) throw new ServiceError(400, err.message);
    throw err;
  }

  await db.$transaction(async (tx) => {
    await proposalRepo.updateItemReferenceProposal(tx, proposalId, { status: rejectedStatus, reviewedByUserId: userId, reviewedAt: new Date(), rejectionReason: reason });
    await recordTransition(tx, "item_reference_proposal", proposalId, proposal.status, rejectedStatus, userId, reason);
    await emitOrgEvent(tx, proposal.orgId, {
      eventType: "item_reference_proposal_rejected",
      version: 1,
      proposalId,
      gtin13: proposal.gtin13,
      rejectionReason: reason,
    });
  });
}
