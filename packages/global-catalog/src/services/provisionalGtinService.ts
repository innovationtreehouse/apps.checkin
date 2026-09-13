import { db } from "../db";
import { createProposalRepository } from "../repositories/proposal";
import { createCatalogRepository } from "../repositories/catalog";
import { nextProvisionalSequenceId } from "../db/sequence";
import { usageBehaviorEnum } from "../db/schema";
import type { ProvisionalItem, ProvisionalItemStatus, UsageBehavior } from "../db/schema";
import { buildProvisionalGtin13 } from "../lib/gtin";
import { ServiceError } from "./categoryService";
import { allocateAndInsertItem, resolveItemContext } from "./itemService";
import { emitOrgEvent, recordTransition } from "./orgEventService";
import { getCanonicalConversion } from "./referenceMatchingService";
import { assertProvisionalProposalTransition } from "../workflows/provisional-proposal.machine";
import type { ProvisionalProposalContext } from "../workflows/provisional-proposal.machine";
import { WorkflowTransitionError } from "@inventory/workflows";

const proposalRepo = createProposalRepository(db);
const catalogRepo = createCatalogRepository(db);

export interface CreateProvisionalItemParams {
  provisionalGtin13: string;
  orgId: string;
  orgName: string;
  localUserId: number;
  proposedName: string;
  proposedCategoryId?: number;
  proposedSubcategoryId?: number;
  proposedUsageBehavior: string;
  partNumber?: string;
  manufacturer?: string;
  retailer?: string;
  conversionFactor?: number;
}

export interface ApproveProvisionalProposalOverrides {
  name?: string;
  categoryId?: number;
  subcategoryId?: number;
  usageBehavior?: string;
}

export async function allocateNextProvisionalGtin(): Promise<{ gtin13: string }> {
  const seqId = await nextProvisionalSequenceId();
  return { gtin13: buildProvisionalGtin13(seqId) };
}

export async function createProvisionalItem(
  params: CreateProvisionalItemParams
): Promise<ProvisionalItem> {
  if (!(usageBehaviorEnum as readonly string[]).includes(params.proposedUsageBehavior)) {
    throw new ServiceError(400, `proposedUsageBehavior must be one of: ${usageBehaviorEnum.join(", ")}`);
  }

  return proposalRepo.createProvisionalItem({
    provisionalGtin13: params.provisionalGtin13,
    orgId: params.orgId,
    orgName: params.orgName,
    localUserId: params.localUserId,
    proposedName: params.proposedName,
    proposedCategoryId: params.proposedCategoryId ?? null,
    proposedSubcategoryId: params.proposedSubcategoryId ?? null,
    proposedUsageBehavior: params.proposedUsageBehavior as UsageBehavior,
    partNumber: params.partNumber ?? null,
    manufacturer: params.manufacturer ?? null,
    retailer: params.retailer ?? null,
    conversionFactor: params.conversionFactor ?? 1,
    status: "pending",
  });
}

export async function approveProvisionalProposal(
  proposalId: number,
  userId: number,
  overrides: ApproveProvisionalProposalOverrides
): Promise<{ realGtin13: string }> {
  const proposal = await proposalRepo.findProvisionalItemById(proposalId);
  if (!proposal) throw new ServiceError(404, "Proposal not found");

  const catId = overrides.categoryId ?? proposal.proposedCategoryId;
  const subId = overrides.subcategoryId ?? proposal.proposedSubcategoryId;

  const approvalContext: ProvisionalProposalContext = {
    hasCategoryResolved: !!catId,
    hasSubcategoryResolved: !!subId,
  };

  let approvedStatus: ProvisionalItemStatus;
  try {
    approvedStatus = assertProvisionalProposalTransition(proposal.status as ProvisionalItemStatus, "APPROVE", approvalContext);
  } catch (err) {
    if (err instanceof WorkflowTransitionError) throw new ServiceError(400, err.message);
    throw err;
  }

  const finalName = overrides.name ?? proposal.proposedName;
  const finalUsageBehavior = overrides.usageBehavior ?? proposal.proposedUsageBehavior;

  if (!(usageBehaviorEnum as readonly string[]).includes(finalUsageBehavior)) {
    throw new ServiceError(400, "Invalid usageBehavior");
  }

  const itemCtx = await resolveItemContext({
    name: finalName,
    // Non-null asserted: the APPROVE transition guard above requires
    // hasCategoryResolved && hasSubcategoryResolved (i.e. both catId and subId truthy).
    categoryId: catId!,
    subcategoryId: subId!,
    usageBehavior: finalUsageBehavior as UsageBehavior,
  });

  const now = new Date();

  return db.$transaction(async (tx) => {
    const created = await allocateAndInsertItem(itemCtx, tx, userId);

    await proposalRepo.updateProvisionalItem(tx, proposalId, { status: approvedStatus, reviewedByUserId: userId, reviewedAt: now, resultGtin13: created.gtin13 });

    await proposalRepo.createProvisionalItemMappingLog(tx, {
      orgId: proposal.orgId,
      provisionalGtin13: proposal.provisionalGtin13,
      realGtin13: created.gtin13,
      mappedAt: now,
      mappedByUserId: userId,
      mappingType: "approved_new",
    });

    await recordTransition(tx, "provisional_item_proposal", proposalId, proposal.status, approvedStatus, userId);
    await emitOrgEvent(tx, proposal.orgId, {
      eventType: "provisional_approved",
      version: 1,
      provisionalGtin13: proposal.provisionalGtin13,
      realGtin13: created.gtin13,
      name: finalName,
      // The new item's canonical factor = the factor the human entered on the
      // provisional proposal at intake. version 1: brand-new item.
      conversionFactor: proposal.conversionFactor,
      conversionVersion: 1,
    });

    if (proposal.partNumber || proposal.manufacturer || proposal.retailer) {
      await tx.itemReferenceProposal.create({
        data: {
          gtin13: created.gtin13,
          orgId: proposal.orgId,
          orgName: proposal.orgName,
          localUserId: proposal.localUserId,
          partNumber: proposal.partNumber?.trim() || null,
          manufacturer: proposal.manufacturer?.trim() || null,
          retailer: proposal.retailer?.trim() || null,
          conversionFactor: proposal.conversionFactor,
          status: "pending",
        },
      });
    }

    return { realGtin13: created.gtin13 };
  });
}

export async function rejectProvisionalProposal(
  proposalId: number,
  userId: number,
  reason: string
): Promise<void> {
  const proposal = await proposalRepo.findProvisionalItemById(proposalId);
  if (!proposal) throw new ServiceError(404, "Proposal not found");
  let rejectedStatus: ProvisionalItemStatus;
  try {
    rejectedStatus = assertProvisionalProposalTransition(proposal.status as ProvisionalItemStatus, "REJECT");
  } catch (err) {
    if (err instanceof WorkflowTransitionError) throw new ServiceError(400, err.message);
    throw err;
  }

  const now = new Date();
  await db.$transaction(async (tx) => {
    await proposalRepo.updateProvisionalItem(tx, proposalId, { status: rejectedStatus, reviewedByUserId: userId, reviewedAt: now, rejectionReason: reason });
    await recordTransition(tx, "provisional_item_proposal", proposalId, proposal.status, rejectedStatus, userId, reason);
    await emitOrgEvent(tx, proposal.orgId, {
      eventType: "provisional_rejected",
      version: 1,
      provisionalGtin13: proposal.provisionalGtin13,
      rejectionReason: reason,
    });
  });
}

export async function mapProvisionalToExisting(
  proposalId: number,
  userId: number,
  realGtin13: string
): Promise<void> {
  const proposal = await proposalRepo.findProvisionalItemById(proposalId);
  if (!proposal) throw new ServiceError(404, "Proposal not found");
  let mappedStatus: ProvisionalItemStatus;
  try {
    mappedStatus = assertProvisionalProposalTransition(proposal.status as ProvisionalItemStatus, "MAP_TO_EXISTING");
  } catch (err) {
    if (err instanceof WorkflowTransitionError) throw new ServiceError(400, err.message);
    throw err;
  }

  const item = await catalogRepo.findItemByGtin13(realGtin13);
  if (!item) throw new ServiceError(400, "Item not found in catalog");

  // Canonical conversion of the EXISTING real item — the consumer compares this
  // against the factor its provisional stock was counted under to decide whether
  // the quantities are directly summable or need human reconciliation.
  const canonical = await getCanonicalConversion(realGtin13);

  const now = new Date();
  await db.$transaction(async (tx) => {
    await proposalRepo.updateProvisionalItem(tx, proposalId, { status: mappedStatus, reviewedByUserId: userId, reviewedAt: now, resultGtin13: realGtin13 });

    await proposalRepo.createProvisionalItemMappingLog(tx, {
      orgId: proposal.orgId,
      provisionalGtin13: proposal.provisionalGtin13,
      realGtin13,
      mappedAt: now,
      mappedByUserId: userId,
      mappingType: "mapped_to_existing",
    });

    await recordTransition(tx, "provisional_item_proposal", proposalId, proposal.status, mappedStatus, userId);
    await emitOrgEvent(tx, proposal.orgId, {
      eventType: "provisional_mapped_to_existing",
      version: 1,
      provisionalGtin13: proposal.provisionalGtin13,
      realGtin13,
      conversionFactor: canonical.conversionFactor,
      conversionVersion: canonical.conversionVersion,
    });
  });
}
