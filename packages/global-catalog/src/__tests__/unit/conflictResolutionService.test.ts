import { beforeAll, expect, it } from "vitest";
import { describeDb } from "../helpers/db";
import { initDb, prisma } from "../../db";
import { resetDb } from "../helpers/db";
import { reportConflict, resolveConflict } from "../../services/conflictResolutionService";
import { list } from "../../routes/referenceConflicts";

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
    await resolveConflict(conflictId, 1, "keep_existing", "1234567890128");
    const row = await prisma.referenceConflict.findFirst({ where: { id: conflictId } });
    expect(row?.resolvedAt).not.toBeNull();
    expect(row?.resolution).toBe("keep_existing");
    expect(row?.resolvedByUserId).toBe(1);
  });

  it("resolves with use_proposed and updates item reference gtin13", async () => {
    await resetDb();
    const { refId } = await seedFixtures();
    const conflictId = await createConflict(refId);
    await resolveConflict(conflictId, 1, "use_proposed", "1234567890128");
    const ref = await prisma.itemReference.findFirst({ where: { id: refId } });
    expect(ref?.gtin13).toBe("9999999999994");
  });

  it("throws 404 when conflict does not exist", async () => {
    await resetDb();
    await seedFixtures();
    await expect(resolveConflict(99999, 1, "keep_existing", "1234567890128"))
      .rejects.toMatchObject({ status: 404 });
  });

  it("throws 409 when conflict is already resolved", async () => {
    await resetDb();
    const { refId } = await seedFixtures();
    const conflictId = await createConflict(refId);
    await resolveConflict(conflictId, 1, "keep_existing", "1234567890128");
    await expect(resolveConflict(conflictId, 1, "keep_existing", "1234567890128"))
      .rejects.toMatchObject({ status: 409 });
  });
});

describeDb("a part that moved after its conflict was raised", () => {
  const RAISED = "1234567890128";
  const FIRST_PROPOSED = "9999999999994";
  const SECOND_PROPOSED = "5555555555557";

  /** Two open conflicts on one part; the first has been resolved, moving the part to FIRST_PROPOSED. */
  async function seedMovedPart(secondProposed = SECOND_PROPOSED) {
    await resetDb();
    const { refId } = await seedFixtures();
    const { categoryId, subcategoryId } = await prisma.item.findFirstOrThrow({ where: { gtin13: RAISED } });
    await prisma.item.create({ data: { gtin13: SECOND_PROPOSED, name: "Second", categoryId, subcategoryId, sequence: 3, usageBehavior: "Durable" } });
    const first = await reportConflict({ itemReferenceId: refId, ...BASE_CONFLICT });
    const second = await reportConflict({ itemReferenceId: refId, ...BASE_CONFLICT, proposedGtin13: secondProposed, lineItemId: 2 });
    await resolveConflict(first.id, 1, "use_proposed", RAISED);
    return { refId, conflictId: second.id };
  }
  const partItem = async (refId: number) => (await prisma.itemReference.findUniqueOrThrow({ where: { id: refId } })).gtin13;
  const conflictRow = (id: number) => prisma.referenceConflict.findUniqueOrThrow({ where: { id } });
  const auditNotes = async (recordId: number) =>
    (await prisma.workflowTransitionLog.findMany({ where: { workflowType: "reference_conflict", recordId } })).map((t) => t.note);

  it("the list shows the item the part is on now beside the item raised", async () => {
    const { conflictId } = await seedMovedPart();
    const { ReferenceConflict } = await list({ req: new Request("http://test/api/catalog/reference-conflicts"), params: {} });
    expect(ReferenceConflict).toEqual([
      expect.objectContaining({ id: conflictId, existingGtin13: RAISED, itemReference: { gtin13: FIRST_PROPOSED } }),
    ]);
  });

  it("use proposed moves the part and records the item it was decided against", async () => {
    const { refId, conflictId } = await seedMovedPart();
    await resolveConflict(conflictId, 2, "use_proposed", FIRST_PROPOSED);
    expect(await partItem(refId)).toBe(SECOND_PROPOSED);
    expect(await conflictRow(conflictId)).toMatchObject({ resolution: "use_proposed", existingGtin13: FIRST_PROPOSED });
    expect(await auditNotes(conflictId)).toEqual([expect.stringContaining(RAISED)]);
  });

  it("keep existing keeps the current item, not the one raised", async () => {
    const { refId, conflictId } = await seedMovedPart();
    await resolveConflict(conflictId, 2, "keep_existing", FIRST_PROPOSED);
    expect(await partItem(refId)).toBe(FIRST_PROPOSED);
    expect(await conflictRow(conflictId)).toMatchObject({ resolution: "keep_existing", existingGtin13: FIRST_PROPOSED });
    expect(await auditNotes(conflictId)).toEqual([expect.stringContaining(RAISED)]);
  });

  it.each(["use_proposed", "keep_existing"] as const)("%s is refused when the part moved after the page loaded", async (resolution) => {
    const { refId, conflictId } = await seedMovedPart();
    await expect(resolveConflict(conflictId, 2, resolution, RAISED)).rejects.toMatchObject({ status: 409 });
    expect(await partItem(refId)).toBe(FIRST_PROPOSED);
    expect(await conflictRow(conflictId)).toMatchObject({ resolvedAt: null, existingGtin13: RAISED });
    expect(await auditNotes(conflictId)).toEqual([]);
  });

  it("closes with the reason in the audit when the part is already on the proposed item", async () => {
    const { refId, conflictId } = await seedMovedPart(FIRST_PROPOSED);
    await resolveConflict(conflictId, 2, "use_proposed", FIRST_PROPOSED);
    expect(await partItem(refId)).toBe(FIRST_PROPOSED);
    const row = await conflictRow(conflictId);
    expect(row.resolvedAt).not.toBeNull();
    expect(row.existingGtin13).toBe(FIRST_PROPOSED);
    const [note] = await auditNotes(conflictId);
    expect(note).toContain("nothing left to decide");
    expect(note).toContain(RAISED);
  });

  it("records no audit note when the part has not moved", async () => {
    await resetDb();
    const { refId } = await seedFixtures();
    const { id } = await reportConflict({ itemReferenceId: refId, ...BASE_CONFLICT });
    await resolveConflict(id, 1, "keep_existing", RAISED);
    expect(await auditNotes(id)).toEqual([null]);
  });
});
