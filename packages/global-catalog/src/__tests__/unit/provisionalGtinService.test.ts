import { beforeEach, expect, it } from "vitest";
import { describeDb, resetDb } from "../helpers/db";
import { prisma } from "../../db";
import { buildGtin13, buildProvisionalGtin13 } from "../../lib/gtin";
import {
  allocateNextProvisionalGtin,
  approveProvisionalProposal,
  createProvisionalItem,
  mapProvisionalToExisting,
  rejectProvisionalProposal,
} from "../../services/provisionalGtinService";

const ORG = { orgId: "org-test-1", orgName: "Test Org" };

beforeEach(resetDb);

async function seedCategory() {
  const cat = await prisma.category.create({ data: { name: "Cat", letter: "P" } });
  const sub = await prisma.subcategory.create({ data: { name: "Sub", number: 1, categoryId: cat.id } });
  return { categoryId: cat.id, subcategoryId: sub.id };
}

async function seedPendingProvisional() {
  const { categoryId, subcategoryId } = await seedCategory();
  const { gtin13 } = await allocateNextProvisionalGtin();
  return createProvisionalItem({
    ...ORG,
    provisionalGtin13: gtin13,
    localUserId: 1,
    proposedName: "Widget",
    proposedCategoryId: categoryId,
    proposedSubcategoryId: subcategoryId,
    proposedUsageBehavior: "Durable",
  });
}

function outcomes(results: PromiseSettledResult<unknown>[]) {
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  return { fulfilled, rejected };
}

describeDb("provisional review actions", () => {
  it("two concurrent approves: one wins, the other gets 409", async () => {
    const proposal = await seedPendingProvisional();

    const { fulfilled, rejected } = outcomes(
      await Promise.allSettled([
        approveProvisionalProposal(proposal.id, 1, {}),
        approveProvisionalProposal(proposal.id, 2, {}),
      ]),
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ status: 409 });
    expect(await prisma.item.count()).toBe(1);
    expect(await prisma.provisionalItemMappingLog.count()).toBe(1);
    expect(await prisma.orgEvent.count({ where: { eventType: "provisional_approved" } })).toBe(1);
  });

  it("a review action that reads after the winner committed gets 409", async () => {
    const proposal = await seedPendingProvisional();
    await approveProvisionalProposal(proposal.id, 1, {});

    await expect(approveProvisionalProposal(proposal.id, 2, {})).rejects.toMatchObject({ status: 409 });
    await expect(rejectProvisionalProposal(proposal.id, 2, "late")).rejects.toMatchObject({ status: 409 });
    await expect(mapProvisionalToExisting(proposal.id, 2, proposal.provisionalGtin13)).rejects.toMatchObject({ status: 409 });
    expect(await prisma.provisionalItemMappingLog.count()).toBe(1);
  });

  it("approving a pending proposal with no category is still a 400", async () => {
    const { gtin13 } = await allocateNextProvisionalGtin();
    const proposal = await createProvisionalItem({
      ...ORG, provisionalGtin13: gtin13, localUserId: 1, proposedName: "Widget", proposedUsageBehavior: "Durable",
    });
    await expect(approveProvisionalProposal(proposal.id, 1, {})).rejects.toMatchObject({ status: 400 });
  });

  it("approve racing map-to-existing records one mapping", async () => {
    const proposal = await seedPendingProvisional();
    const categoryId = proposal.proposedCategoryId!;
    const subcategoryId = proposal.proposedSubcategoryId!;
    const realGtin13 = buildGtin13("P", 1, 9);
    await prisma.item.create({ data: {
      gtin13: realGtin13, name: "Existing", categoryId, subcategoryId,
      sequence: 9, usageBehavior: "Durable", createdAt: new Date(), updatedAt: new Date(),
    } });

    const { fulfilled, rejected } = outcomes(
      await Promise.allSettled([
        approveProvisionalProposal(proposal.id, 1, {}),
        mapProvisionalToExisting(proposal.id, 2, realGtin13),
      ]),
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ status: 409 });
    expect(await prisma.provisionalItemMappingLog.count()).toBe(1);
  });
});

describeDb("createProvisionalItem GTIN guard", () => {
  const base = { ...ORG, localUserId: 1, proposedName: "Widget", proposedUsageBehavior: "Durable" };

  it("refuses a real (non-provisional) GTIN", async () => {
    await expect(createProvisionalItem({ ...base, provisionalGtin13: buildGtin13("P", 1, 1) }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("refuses a provisional-shaped GTIN whose sequence was never allocated", async () => {
    await expect(createProvisionalItem({ ...base, provisionalGtin13: buildProvisionalGtin13(424242) }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("refuses a provisional-shaped GTIN whose sequence field holds a minus sign", async () => {
    await expect(createProvisionalItem({ ...base, provisionalGtin13: "0200-12712340" }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("refuses an allocated sequence with a wrong check digit", async () => {
    const { gtin13 } = await allocateNextProvisionalGtin();
    const bad = gtin13.slice(0, 12) + String((Number(gtin13[12]) + 1) % 10);
    await expect(createProvisionalItem({ ...base, provisionalGtin13: bad }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("accepts an allocated provisional GTIN", async () => {
    const { gtin13 } = await allocateNextProvisionalGtin();
    await expect(createProvisionalItem({ ...base, provisionalGtin13: gtin13 }))
      .resolves.toMatchObject({ provisionalGtin13: gtin13, status: "pending" });
  });
});
