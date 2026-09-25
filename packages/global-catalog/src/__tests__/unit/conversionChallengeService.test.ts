import { beforeAll, expect, it } from "vitest";
import { describeDb } from "../helpers/db";
import { initDb, prisma } from "../../db";
import { resetDb } from "../helpers/db";
import { submitChallenge, acceptChallenge, rejectChallenge } from "../../services/conversionChallengeService";

beforeAll(async () => {
  await initDb();
});

async function seedRef() {
  const cat = await prisma.category.create({ data: { name: "Challenge Cat", letter: "V" } });
  const sub = await prisma.subcategory.create({ data: { name: "Challenge Sub", number: 1, categoryId: cat.id } });
  const now = new Date();
  await prisma.item.create({ data: { gtin13: "1234567890128", name: "Widget", categoryId: cat.id, subcategoryId: sub.id, sequence: 1, usageBehavior: "Durable", createdAt: now, updatedAt: now } });
  const ref = await prisma.itemReference.create({ data: {
    gtin13: "1234567890128",
    partNumber: "CC-001",
    manufacturer: "ChalCo",
    retailer: "Shop",
    descriptionNormalized: "widget",
    conversionFactor: 1.0,
    conversionVersion: 1,
  } });
  return { refId: ref.id };
}

const BASE_SUBMIT = {
  orgId: "org-abc",
  orgName: "Test Org",
  localUserId: 10,
  proposedFactor: 3.0,
  reason: "Sold in 3-packs",
};

describeDb("submitChallenge", () => {
  it("creates a pending challenge", async () => {
    await resetDb();
    const { refId } = await seedRef();
    const ch = await submitChallenge({ ...BASE_SUBMIT, itemReferenceId: refId });
    expect(ch.status).toBe("pending");
    expect(ch.proposedFactor).toBe(3.0);
    expect(ch.orgId).toBe("org-abc");
  });

  it("throws 400 when proposedFactor is zero", async () => {
    await resetDb();
    const { refId } = await seedRef();
    await expect(submitChallenge({ ...BASE_SUBMIT, itemReferenceId: refId, proposedFactor: 0 }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("throws 400 when proposedFactor is negative", async () => {
    await resetDb();
    const { refId } = await seedRef();
    await expect(submitChallenge({ ...BASE_SUBMIT, itemReferenceId: refId, proposedFactor: -1 }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("throws 404 when itemReferenceId does not exist", async () => {
    await resetDb();
    await seedRef();
    await expect(submitChallenge({ ...BASE_SUBMIT, itemReferenceId: 99999 }))
      .rejects.toMatchObject({ status: 404 });
  });

  it("throws 409 when a pending challenge already exists from same org", async () => {
    await resetDb();
    const { refId } = await seedRef();
    await submitChallenge({ ...BASE_SUBMIT, itemReferenceId: refId });
    await expect(submitChallenge({ ...BASE_SUBMIT, itemReferenceId: refId }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("allows a second challenge from a different org", async () => {
    await resetDb();
    const { refId } = await seedRef();
    await submitChallenge({ ...BASE_SUBMIT, itemReferenceId: refId });
    const ch2 = await submitChallenge({ ...BASE_SUBMIT, orgId: "org-other", orgName: "Other Org", itemReferenceId: refId });
    expect(ch2.status).toBe("pending");
  });

  it("trims whitespace from reason", async () => {
    await resetDb();
    const { refId } = await seedRef();
    const ch = await submitChallenge({ ...BASE_SUBMIT, itemReferenceId: refId, reason: "  spaces  " });
    expect(ch.reason).toBe("spaces");
  });
});

describeDb("acceptChallenge", () => {
  async function seedPending(refId: number) {
    return submitChallenge({ ...BASE_SUBMIT, itemReferenceId: refId });
  }

  it("marks challenge accepted and updates conversion factor on item reference", async () => {
    await resetDb();
    const { refId } = await seedRef();
    const ch = await seedPending(refId);
    await acceptChallenge(ch.id, 1);
    const updated = await prisma.conversionChallenge.findFirst({ where: { id: ch.id } });
    expect(updated?.status).toBe("accepted");
    expect(updated?.reviewedByUserId).toBe(1);
    const ref = await prisma.itemReference.findFirst({ where: { id: refId } });
    expect(ref?.conversionFactor).toBe(3.0);
    expect(ref?.conversionVersion).toBe(2);
  });

  it("throws 404 when challenge does not exist", async () => {
    await resetDb();
    await seedRef();
    await expect(acceptChallenge(99999, 1)).rejects.toMatchObject({ status: 404 });
  });

  it("throws 400 when challenge is not pending (invalid transition)", async () => {
    await resetDb();
    const { refId } = await seedRef();
    const ch = await seedPending(refId);
    await acceptChallenge(ch.id, 1);
    await expect(acceptChallenge(ch.id, 1)).rejects.toMatchObject({ status: 400 });
  });
});

describeDb("rejectChallenge", () => {
  async function seedPending(refId: number) {
    return submitChallenge({ ...BASE_SUBMIT, itemReferenceId: refId });
  }

  it("marks challenge rejected and does not change conversion factor", async () => {
    await resetDb();
    const { refId } = await seedRef();
    const ch = await seedPending(refId);
    await rejectChallenge(ch.id, 1);
    const updated = await prisma.conversionChallenge.findFirst({ where: { id: ch.id } });
    expect(updated?.status).toBe("rejected");
    const ref = await prisma.itemReference.findFirst({ where: { id: refId } });
    expect(ref?.conversionFactor).toBe(1.0);
  });

  it("throws 404 when challenge does not exist", async () => {
    await resetDb();
    await seedRef();
    await expect(rejectChallenge(99999, 1)).rejects.toMatchObject({ status: 404 });
  });

  it("throws 400 when challenge is already resolved (invalid transition)", async () => {
    await resetDb();
    const { refId } = await seedRef();
    const ch = await seedPending(refId);
    await rejectChallenge(ch.id, 1);
    await expect(rejectChallenge(ch.id, 1)).rejects.toMatchObject({ status: 400 });
  });
});
