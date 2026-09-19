import { beforeAll, expect, it } from "vitest";
import { describeDb } from "@/__tests__/helpers/db";
import { initDb, prisma } from "@/db";
import { resetDb } from "@/__tests__/helpers/db";
import { reportConflict, resolveConflict } from "@/services/conflictResolutionService";

beforeAll(async () => {
  await initDb();
});

async function seedFixtures() {
  const cat = await prisma.category.create({ data: { name: "Conflict Cat", letter: "Z" } });
  const sub = await prisma.subcategory.create({ data: { name: "Conflict Sub", number: 1, categoryId: cat.id } });
  const now = new Date();
  await prisma.item.create({ data: { gtin13: "1234567890128", name: "Existing", categoryId: cat.id, subcategoryId: sub.id, sequence: 1, usageBehavior: "Durable", createdAt: now, updatedAt: now } });
  await prisma.item.create({ data: { gtin13: "9999999999994", name: "Proposed", categoryId: cat.id, subcategoryId: sub.id, sequence: 2, usageBehavior: "Durable", createdAt: now, updatedAt: now } });
  const ref = await prisma.itemReference.create({ data: {
    gtin13: "1234567890128",
    partNumber: "PART-1",
    manufacturer: "Mfr",
    retailer: "Ret",
    descriptionNormalized: "test",
    conversionFactor: 1.0,
    conversionVersion: 1,
  } });
  return { refId: ref.id };
}

const BASE_CONFLICT = {
  existingGtin13: "1234567890128",
  proposedGtin13: "9999999999994",
  manufacturer: "Mfr",
  retailer: "Ret",
  partNumber: "PART-1",
  description: "test",
  receiptId: "receipt-001",
  lineItemId: 1,
};

describeDb("reportConflict", () => {
  it("creates a conflict record and returns its id", async () => {
    await resetDb();
    const { refId } = await seedFixtures();
    const result = await reportConflict({ itemReferenceId: refId, ...BASE_CONFLICT });
    expect(typeof result.id).toBe("number");
    expect(result.id).toBeGreaterThan(0);
  });

  it("throws 400 when existingGtin13 not in items table", async () => {
    await resetDb();
    const { refId } = await seedFixtures();
    await expect(reportConflict({ itemReferenceId: refId, ...BASE_CONFLICT, existingGtin13: "0000000000000" }))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/GTIN not found/i) });
  });

  it("throws 400 when proposedGtin13 not in items table", async () => {
    await resetDb();
    const { refId } = await seedFixtures();
    await expect(reportConflict({ itemReferenceId: refId, ...BASE_CONFLICT, proposedGtin13: "0000000000000" }))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/GTIN not found/i) });
  });

  it("persists optional fields as null when omitted", async () => {
    await resetDb();
    const { refId } = await seedFixtures();
    const result = await reportConflict({ itemReferenceId: refId, existingGtin13: "1234567890128", proposedGtin13: "9999999999994", receiptId: "r-2", lineItemId: 2 });
    const row = await prisma.referenceConflict.findFirst({ where: { id: result.id } });
    expect(row?.manufacturer).toBeNull();
    expect(row?.retailer).toBeNull();
    expect(row?.partNumber).toBeNull();
  });
});

describeDb("resolveConflict", () => {
  async function createConflict(refId: number) {
    const result = await reportConflict({ itemReferenceId: refId, ...BASE_CONFLICT });
    return result.id;
  }

  it("resolves with keep_existing and marks resolvedAt", async () => {
    await resetDb();
    const { refId } = await seedFixtures();
    const conflictId = await createConflict(refId);
    await resolveConflict(conflictId, 1, "keep_existing");
    const row = await prisma.referenceConflict.findFirst({ where: { id: conflictId } });
    expect(row?.resolvedAt).not.toBeNull();
    expect(row?.resolution).toBe("keep_existing");
    expect(row?.resolvedByUserId).toBe(1);
  });

  it("resolves with use_proposed and updates item reference gtin13", async () => {
    await resetDb();
    const { refId } = await seedFixtures();
    const conflictId = await createConflict(refId);
    await resolveConflict(conflictId, 1, "use_proposed");
    const ref = await prisma.itemReference.findFirst({ where: { id: refId } });
    expect(ref?.gtin13).toBe("9999999999994");
  });

  it("throws 404 when conflict does not exist", async () => {
    await resetDb();
    await seedFixtures();
    await expect(resolveConflict(99999, 1, "keep_existing"))
      .rejects.toMatchObject({ status: 404 });
  });

  it("throws 400 when conflict is already resolved (invalid transition)", async () => {
    await resetDb();
    const { refId } = await seedFixtures();
    const conflictId = await createConflict(refId);
    await resolveConflict(conflictId, 1, "keep_existing");
    await expect(resolveConflict(conflictId, 1, "keep_existing"))
      .rejects.toMatchObject({ status: 400 });
  });
});
