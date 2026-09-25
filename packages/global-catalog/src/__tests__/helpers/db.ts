import { describe } from "vitest";
import { prisma, initDb } from "../../db";

/**
 * DB-gate for the integration + DB-backed service tiers. `describeDb` is `describe` when
 * CATALOG_DATABASE_URL is set (the harness publishes the container URL in
 * test/setupEnv.ts) and `describe.skip` otherwise — so suites that need a real Postgres run
 * against the throwaway container when Docker is up, and cleanly skip (not fail) without it.
 */
export const describeDb = process.env.CATALOG_DATABASE_URL ? describe : describe.skip;

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
