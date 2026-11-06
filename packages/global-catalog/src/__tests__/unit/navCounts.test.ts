/** The nav pill counts agree with the lists each pill leads to. Real Postgres; describeDb skips without one. */
import { beforeEach, expect, it } from "vitest";
import { describeDb, resetDb } from "../helpers/db";
import { prisma } from "../../db";
import { list as listChallenges } from "../../routes/conversionChallenges";
import { list as listReferences } from "../../routes/proposals";
import { list as listProvisional } from "../../routes/provisionalItems";
import { list as listConflicts } from "../../routes/referenceConflicts";
import { getNavCounts } from "../../services/proposalService";
import type { CatalogRouteHandler } from "../../contract";

const GTIN = "0011111111116";
const OTHER_GTIN = "0022222222223";
const ORG_ONE = { orgId: "org-1", orgName: "Org One", localUserId: 1 };
const ORG_TWO = { orgId: "org-2", orgName: "Org Two", localUserId: 2 };

async function rows(handler: CatalogRouteHandler, key: string): Promise<{ status?: string }[]> {
  const bag = await handler({ req: new Request("http://test/?limit=200"), params: {} });
  return (bag as Record<string, { status?: string }[]>)[key];
}

async function seedReference() {
  const category = await prisma.category.create({ data: { name: "Cat", letter: "N" } });
  const subcategory = await prisma.subcategory.create({ data: { name: "Sub", number: 1, categoryId: category.id } });
  for (const [i, gtin13] of [GTIN, OTHER_GTIN].entries()) {
    await prisma.item.create({ data: { gtin13, name: `Item ${i}`, categoryId: category.id, subcategoryId: subcategory.id, sequence: i + 1, usageBehavior: "Durable" } });
  }
  return prisma.itemReference.create({ data: { gtin13: GTIN, partNumber: "P-1", manufacturer: "Acme" } });
}

function provisional(org: typeof ORG_ONE, provisionalGtin13: string, status: string) {
  return prisma.provisionalItem.create({ data: { ...org, provisionalGtin13, proposedName: "Thing", proposedUsageBehavior: "Durable", status } });
}

beforeEach(resetDb);

describeDb("catalog nav counts", () => {
  it("count only open rows, across every org, matching each list", async () => {
    const reference = await seedReference();

    await provisional(ORG_ONE, "0200000000011", "pending");
    await provisional(ORG_TWO, "0200000000028", "pending");
    await provisional(ORG_ONE, "0200000000035", "approved");
    await provisional(ORG_ONE, "0200000000042", "rejected");
    await provisional(ORG_ONE, "0200000000059", "mapped_to_existing");

    await prisma.itemReferenceProposal.create({ data: { ...ORG_ONE, gtin13: GTIN, partNumber: "A", status: "pending" } });
    await prisma.itemReferenceProposal.create({ data: { ...ORG_TWO, gtin13: GTIN, partNumber: "B", status: "pending" } });
    await prisma.itemReferenceProposal.create({ data: { ...ORG_ONE, gtin13: GTIN, partNumber: "C", status: "approved" } });

    const conflict = { itemReferenceId: reference.id, existingGtin13: GTIN, proposedGtin13: OTHER_GTIN, receiptId: "r-1" };
    await prisma.referenceConflict.create({ data: { ...conflict, lineItemId: 1 } });
    await prisma.referenceConflict.create({ data: { ...conflict, lineItemId: 2, resolvedAt: new Date() } });

    const challenge = { itemReferenceId: reference.id, currentFactor: 1, proposedFactor: 2, reason: "pack size" };
    await prisma.conversionChallenge.create({ data: { ...ORG_ONE, ...challenge, status: "pending" } });
    await prisma.conversionChallenge.create({ data: { ...ORG_TWO, ...challenge, status: "pending" } });
    await prisma.conversionChallenge.create({ data: { ...ORG_ONE, ...challenge, status: "rejected" } });

    const counts = await getNavCounts();

    expect(counts).toEqual({ pendingProvisionalItems: 2, pendingItemReferences: 2, unresolvedConflicts: 1, pendingChallenges: 2 });
    // The provisional list returns every status and its screen filters to pending.
    expect((await rows(listProvisional, "ProvisionalItem")).filter((p) => p.status === "pending").length).toBe(counts.pendingProvisionalItems);
    expect((await rows(listReferences, "ItemReferenceProposal")).length).toBe(counts.pendingItemReferences);
    expect((await rows(listConflicts, "ReferenceConflict")).length).toBe(counts.unresolvedConflicts);
    expect((await rows(listChallenges, "ConversionChallenge")).length).toBe(counts.pendingChallenges);
  });
});
