/** The receipt-types submission payloads a consumer sends, parsed and org-stamped, are accepted by the catalog services. */
import { beforeEach, expect, it } from "vitest";
import {
  catalogItemReferenceProposalSchema,
  catalogProvisionalItemProposalSchema,
  catalogReferenceConflictSchema,
} from "@checkin/receipt-types";
import { prisma } from "../../db";
import { describeDb, resetDb } from "../helpers/db";
import { createItemReferenceProposal } from "../../services/proposalService";
import { reportConflict } from "../../services/conflictResolutionService";
import { allocateNextProvisionalGtin, createProvisionalItem } from "../../services/provisionalGtinService";

const ORG = { orgId: "org-contract", orgName: "Contract Org" };
const EXISTING = "1234567890128";
const PROPOSED = "9999999999994";

let refId: number;

beforeEach(async () => {
  await resetDb();
  if (!process.env.CATALOG_DATABASE_URL) return;
  const cat = await prisma.category.create({ data: { name: "Contract", letter: "C" } });
  const sub = await prisma.subcategory.create({ data: { name: "Sub", number: 1, categoryId: cat.id } });
  for (const [sequence, gtin13] of [EXISTING, PROPOSED].entries()) {
    await prisma.item.create({
      data: { gtin13, name: gtin13, categoryId: cat.id, subcategoryId: sub.id, sequence: sequence + 1, usageBehavior: "Durable" },
    });
  }
  refId = (await prisma.itemReference.create({ data: { gtin13: EXISTING, partNumber: "HB-1", retailer: "Hardware Co" } })).id;
});

describeDb("catalog submissions contract", () => {
  it("accepts an item-reference proposal", async () => {
    const p = catalogItemReferenceProposalSchema.parse({
      gtin13: PROPOSED, localUserId: 7, partNumber: "HB-1", retailer: "Hardware Co", conversionFactor: 4,
    });
    const row = await createItemReferenceProposal({ ...p, ...ORG });
    expect(row).toMatchObject({ gtin13: PROPOSED, orgId: ORG.orgId, localUserId: 7, conversionFactor: 4, status: "pending" });
  });

  it("accepts a reference conflict", async () => {
    const p = catalogReferenceConflictSchema.parse({
      itemReferenceId: refId, existingGtin13: EXISTING, proposedGtin13: PROPOSED,
      receiptId: "42", lineItemId: 3, retailer: "Hardware Co", partNumber: "HB-1",
    });
    const { id } = await reportConflict(p);
    expect(await prisma.referenceConflict.findUniqueOrThrow({ where: { id } })).toMatchObject({ receiptId: "42", lineItemId: 3 });
  });

  it("accepts a provisional-item proposal on an allocated GTIN", async () => {
    const { gtin13 } = await allocateNextProvisionalGtin();
    const p = catalogProvisionalItemProposalSchema.parse({
      provisionalGtin13: gtin13, proposedName: "Mystery bolt", proposedUsageBehavior: "Durable", localUserId: 7, conversionFactor: 2,
    });
    const row = await createProvisionalItem({ ...p, ...ORG });
    expect(row).toMatchObject({ provisionalGtin13: gtin13, orgId: ORG.orgId, status: "pending" });
  });
});
