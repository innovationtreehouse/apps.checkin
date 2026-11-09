import { backendPid, waitersBehind } from "@checkin/pg-test-harness";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { describeDb, resetDb } from "../helpers/db";
import { initDb, prisma } from "../../db";
import type { Prisma } from "../../generated/prisma/client";
import { configureCatalog } from "../../runtime";
import { create, unarchive, update } from "../../routes/itemReferences";
import { approveItemReferenceProposal, createItemReferenceProposal } from "../../services/proposalService";
import { approveProvisionalProposal, createProvisionalItem, allocateNextProvisionalGtin } from "../../services/provisionalGtinService";
import { acceptChallenge, lockChallengeSubmission, submitChallenge } from "../../services/conversionChallengeService";
import { resolveConflict } from "../../services/conflictResolutionService";
import { checkReferences, lockReferenceKeys, lookupMany, type RefFields } from "../../services/referenceMatchingService";

const G1 = "0011111111116";
const G2 = "0022222222223";
const ORG = { orgId: "org-1", orgName: "Org One", localUserId: 1 };
const PART: RefFields = { partNumber: "P-1", manufacturer: "Acme", retailer: null, description: null };
const PART_ROW = { partNumber: "P-1", manufacturer: "Acme" };

let categoryId: number;
let subcategoryId: number;

beforeAll(async () => {
  await initDb();
  configureCatalog({
    auth: { getPrincipal: async () => ({ id: 1, name: "Reviewer" }) },
    org: async () => ({ id: ORG.orgId, name: ORG.orgName }),
  });
});

beforeEach(async () => {
  await resetDb();
  const cat = await prisma.category.create({ data: { name: "Cat", letter: "R" } });
  const sub = await prisma.subcategory.create({ data: { name: "Sub", number: 1, categoryId: cat.id } });
  categoryId = cat.id;
  subcategoryId = sub.id;
  for (const [i, gtin13] of [G1, G2].entries()) {
    await prisma.item.create({ data: { gtin13, name: `Item ${i}`, categoryId, subcategoryId, sequence: i + 1, usageBehavior: "Durable" } });
  }
});

const activeRefs = () => prisma.itemReference.findMany({ where: { ...PART_ROW, archivedAt: null } });
const post = (body: object) => ({ req: new Request("http://test/refs", { method: "POST", body: JSON.stringify(body) }), params: {} });

/** Runs `action` while another transaction holds `hold` uncommitted, committing once `action` waits on its locks. */
async function racing<T>(hold: (tx: Prisma.TransactionClient) => Promise<unknown>, action: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let held!: (pid: number) => void;
  const isHeld = new Promise<number>((r) => (held = r));
  const holder = prisma.$transaction(
    async (tx) => {
      await hold(tx);
      held(await backendPid(tx));
      await released;
    },
    { timeout: 20_000 },
  );
  const holderPid = await isHeld;
  const result = Promise.allSettled([action()]).then(([r]) => r);
  try {
    await waitersBehind(prisma, holderPid);
  } finally {
    release();
    await holder;
  }
  return result;
}

/** Another writer that took the key's lock and is about to commit a reference to G1. */
const competingReferenceOnG1 = async (tx: Prisma.TransactionClient) => {
  await lockReferenceKeys(tx, PART);
  await tx.itemReference.create({ data: { gtin13: G1, ...PART_ROW } });
};

describeDb("one lookup key points at one item", () => {
  it("approving a proposal for a key another item holds is a 409 and leaves it pending", async () => {
    await prisma.itemReference.create({ data: { gtin13: G1, ...PART_ROW } });
    const proposal = await createItemReferenceProposal({ gtin13: G2, ...ORG, ...PART_ROW });

    await expect(approveItemReferenceProposal(proposal.id, 1)).rejects.toMatchObject({ status: 409 });

    expect((await activeRefs()).map((r) => r.gtin13)).toEqual([G1]);
    expect((await prisma.itemReferenceProposal.findUnique({ where: { id: proposal.id } }))?.status).toBe("pending");
  });

  it("the same key may stay on the same item", async () => {
    await prisma.itemReference.create({ data: { gtin13: G1, ...PART_ROW, retailer: "Shop A" } });
    const proposal = await createItemReferenceProposal({ gtin13: G1, ...ORG, ...PART_ROW, retailer: "Shop B" });

    await approveItemReferenceProposal(proposal.id, 1);

    expect(await activeRefs()).toHaveLength(2);
  });

  it("the proposal a provisional approval creates goes through the same check", async () => {
    const { gtin13 } = await allocateNextProvisionalGtin();
    const provisional = await createProvisionalItem({
      provisionalGtin13: gtin13, ...ORG, proposedName: "New", proposedCategoryId: categoryId,
      proposedSubcategoryId: subcategoryId, proposedUsageBehavior: "Durable", ...PART_ROW,
    });
    await prisma.itemReference.create({ data: { gtin13: G1, ...PART_ROW } });

    const { realGtin13 } = await approveProvisionalProposal(provisional.id, 1, {});
    const proposal = await prisma.itemReferenceProposal.findFirstOrThrow({ where: { gtin13: realGtin13 } });

    await expect(approveItemReferenceProposal(proposal.id, 1)).rejects.toMatchObject({ status: 409 });
    expect(await activeRefs()).toHaveLength(1);
  });

  it("moving a reference onto a new item is refused while another reference keeps its key on the old one", async () => {
    const moved = await prisma.itemReference.create({ data: { gtin13: G1, ...PART_ROW, retailer: "Shop A" } });
    await prisma.itemReference.create({ data: { gtin13: G1, ...PART_ROW, retailer: "Shop B" } });
    const conflict = await prisma.referenceConflict.create({
      data: { itemReferenceId: moved.id, existingGtin13: G1, proposedGtin13: G2, receiptId: "r-1", lineItemId: 1 },
    });

    await expect(resolveConflict(conflict.id, 1, "use_proposed", G1)).rejects.toMatchObject({ status: 409 });

    expect((await prisma.itemReference.findUnique({ where: { id: moved.id } }))?.gtin13).toBe(G1);
    expect((await prisma.referenceConflict.findUnique({ where: { id: conflict.id } }))?.resolvedAt).toBeNull();
  });

  it("moving the only reference with its key onto a new item is allowed", async () => {
    const moved = await prisma.itemReference.create({ data: { gtin13: G1, ...PART_ROW } });
    const conflict = await prisma.referenceConflict.create({
      data: { itemReferenceId: moved.id, existingGtin13: G1, proposedGtin13: G2, receiptId: "r-1", lineItemId: 1 },
    });

    await resolveConflict(conflict.id, 1, "use_proposed", G1);

    expect((await prisma.itemReference.findUnique({ where: { id: moved.id } }))?.gtin13).toBe(G2);
  });

  it("a create racing a create on another item gets a 409", async () => {
    const result = await racing(competingReferenceOnG1, () => create(post({ gtin13: G2, ...PART_ROW })));
    expect(result).toMatchObject({ status: "rejected", reason: { status: 409 } });
    expect((await activeRefs()).map((r) => r.gtin13)).toEqual([G1]);
  });

  it("an approval racing a create on another item gets a 409", async () => {
    const proposal = await createItemReferenceProposal({ gtin13: G2, ...ORG, ...PART_ROW });
    const result = await racing(competingReferenceOnG1, () => approveItemReferenceProposal(proposal.id, 1));
    expect(result).toMatchObject({ status: "rejected", reason: { status: 409 } });
    expect((await activeRefs()).map((r) => r.gtin13)).toEqual([G1]);
  });

  it("an update racing a create on another item gets a 409", async () => {
    const own = await prisma.itemReference.create({ data: { gtin13: G2, partNumber: "OTHER", manufacturer: "Acme" } });
    const result = await racing(competingReferenceOnG1, () =>
      update({ ...post(PART_ROW), params: { id: String(own.id) } }),
    );
    expect(result).toMatchObject({ status: "rejected", reason: { status: 409 } });
    expect((await activeRefs()).map((r) => r.gtin13)).toEqual([G1]);
  });

  it("an unarchive racing a create on another item gets a 409", async () => {
    const own = await prisma.itemReference.create({ data: { gtin13: G2, ...PART_ROW, archivedAt: new Date() } });
    const result = await racing(competingReferenceOnG1, () =>
      unarchive({ ...post({}), params: { id: String(own.id) } }),
    );
    expect(result).toMatchObject({ status: "rejected", reason: { status: 409 } });
    expect((await activeRefs()).map((r) => r.gtin13)).toEqual([G1]);
  });
});

describeDb("a reference that changes while a write is on its way", () => {
  /** An active reference holding the key on G1, plus `own` on G1 and an open conflict moving `own` to G2. */
  async function seed(own: Prisma.ItemReferenceUncheckedCreateInput) {
    await prisma.itemReference.create({ data: { gtin13: G1, ...PART_ROW, retailer: "Shop A" } });
    const ref = await prisma.itemReference.create({ data: own });
    const conflict = await prisma.referenceConflict.create({
      data: { itemReferenceId: ref.id, existingGtin13: G1, proposedGtin13: G2, receiptId: "r-1", lineItemId: 1 },
    });
    return { ref, conflict };
  }
  const movedToG2 = (id: number) => (tx: Prisma.TransactionClient) =>
    tx.itemReference.update({ where: { id }, data: { gtin13: G2 } });

  it("an unarchive checks the item the reference was just moved to", async () => {
    const { ref } = await seed({ gtin13: G1, ...PART_ROW, retailer: "Shop B", archivedAt: new Date() });
    const result = await racing(movedToG2(ref.id), () => unarchive({ ...post({}), params: { id: String(ref.id) } }));
    expect(result).toMatchObject({ status: "rejected", reason: { status: 409 } });
    expect((await activeRefs()).map((r) => r.gtin13)).toEqual([G1]);
  });

  it("an update checks the item the reference was just moved to", async () => {
    const { ref } = await seed({ gtin13: G1, partNumber: "OTHER", manufacturer: "Acme" });
    const result = await racing(movedToG2(ref.id), () => update({ ...post(PART_ROW), params: { id: String(ref.id) } }));
    expect(result).toMatchObject({ status: "rejected", reason: { status: 409 } });
    expect((await activeRefs()).map((r) => r.gtin13)).toEqual([G1]);
  });

  it("a resolve checks a reference that was just unarchived", async () => {
    const { ref, conflict } = await seed({ gtin13: G1, ...PART_ROW, retailer: "Shop B", archivedAt: new Date() });
    const result = await racing(
      (tx) => tx.itemReference.update({ where: { id: ref.id }, data: { archivedAt: null } }),
      () => resolveConflict(conflict.id, 1, "use_proposed", G1),
    );
    expect(result).toMatchObject({ status: "rejected", reason: { status: 409 } });
    expect((await prisma.itemReference.findUniqueOrThrow({ where: { id: ref.id } })).gtin13).toBe(G1);
  });
});

describeDb("conversion challenges", () => {
  const seedRef = () => prisma.itemReference.create({ data: { gtin13: G1, ...PART_ROW, conversionFactor: 1 } });
  const challenge = (itemReferenceId: number, proposedFactor: number, orgId = ORG.orgId) =>
    submitChallenge({ ...ORG, orgId, itemReferenceId, proposedFactor, reason: "pack size" });

  it("accepting a challenge whose factor is out of date is a 409 and changes nothing", async () => {
    const ref = await seedRef();
    const first = await challenge(ref.id, 2);
    const second = await challenge(ref.id, 3, "org-2");
    await acceptChallenge(first.id, 1);

    await expect(acceptChallenge(second.id, 1)).rejects.toMatchObject({ status: 409 });

    const after = await prisma.itemReference.findUniqueOrThrow({ where: { id: ref.id } });
    expect(after.conversionFactor).toBe(2);
    expect(after.conversionVersion).toBe(2);
    expect((await prisma.conversionChallenge.findUnique({ where: { id: second.id } }))?.status).toBe("pending");
    expect(await prisma.orgEvent.count({ where: { eventType: "conversion_challenge_accepted" } })).toBe(1);
  });

  it("a submission racing another from the same org gets a 409", async () => {
    const ref = await seedRef();
    const result = await racing(
      async (tx) => {
        await lockChallengeSubmission(tx, ref.id, ORG.orgId);
        await tx.conversionChallenge.create({
          data: { ...ORG, itemReferenceId: ref.id, currentFactor: 1, proposedFactor: 2, reason: "pack size", status: "pending" },
        });
      },
      () => challenge(ref.id, 3),
    );
    expect(result).toMatchObject({ status: "rejected", reason: { status: 409 } });
    expect(await prisma.conversionChallenge.count({ where: { itemReferenceId: ref.id, status: "pending" } })).toBe(1);
  });

  it("another org's pending challenge does not block a submission", async () => {
    const ref = await seedRef();
    await challenge(ref.id, 2, "org-2");
    await expect(challenge(ref.id, 3)).resolves.toMatchObject({ status: "pending" });
  });
});

describeDb("manufacturer + description lookup", () => {
  const widget = { manufacturer: "Acme", descriptionNormalized: "widget" };
  const byDescription = () => lookupMany("Shop", [{ index: 0, manufacturer: "Acme", description: "Widget" }]);

  it("doesn't answer with a reference that has a part number", async () => {
    await prisma.itemReference.create({ data: { ...widget, gtin13: G1, partNumber: "P-1" } });

    expect(await byDescription()).toMatchObject([{ gtin13: null }]);
    expect(await checkReferences({ manufacturer: "Acme", description: "Widget" })).toMatchObject({
      mfr_desc: { exists: false },
      wouldCreateNewReference: true,
    });
  });

  it("answers with the description-only reference when a part-number reference shares its description", async () => {
    await prisma.itemReference.create({ data: { ...widget, gtin13: G1, partNumber: "P-1" } });
    await prisma.itemReference.create({ data: { ...widget, gtin13: G2 } });

    expect(await byDescription()).toMatchObject([{ gtin13: G2 }]);
  });
});
