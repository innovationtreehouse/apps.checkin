import { describeDb as gate } from "@inventory/pg-test-harness";
import { prisma, initDb } from "../../db";

export const describeDb = gate("CATALOG_DATABASE_URL");

export async function resetDb(): Promise<void> {
  // No-op without a database URL so a `beforeAll(resetDb)` in a skipped suite (Docker absent)
  // doesn't connect; the suite bodies are describeDb.skip anyway.
  if (!process.env.CATALOG_DATABASE_URL) return;
  await prisma.orgEvent.deleteMany();
  await prisma.workflowTransitionLog.deleteMany();
  await prisma.provisionalItemMappingLog.deleteMany();
  await prisma.conversionChallenge.deleteMany();
  await prisma.itemReferenceProposal.deleteMany();
  await prisma.itemReference.deleteMany();
  await prisma.referenceConflict.deleteMany();
  await prisma.provisionalItem.deleteMany();
  await prisma.item.deleteMany();
  await prisma.subcategory.deleteMany();
  await prisma.category.deleteMany();
  await prisma.provisionalPartSequence.deleteMany();
  await initDb();
}
