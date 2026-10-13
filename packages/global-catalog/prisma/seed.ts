/**
 * Catalog dev/test seed (#1286 §12). Writes the baseline reference rows lifted
 * from Inventory's setup-test-data.sh — category Electronics/N, subcategory
 * Control System/10, two items, one item-reference — directly via the catalog
 * Prisma client / services against CATALOG_DATABASE_URL (NOT over HTTP + the
 * retired /api/auth/login the source script used). Idempotent by name/letter so
 * a re-run is safe; the flow harness reseeds a fresh DB each run anyway.
 */
import * as dotenv from "dotenv";
import { getPrisma, initDb } from "../src/db";
import { createCatalogRepository } from "../src/repositories/catalog";
import { createItemReferenceRepository } from "../src/repositories/itemReference";
import { createItem } from "../src/services/itemService";

dotenv.config();

async function main(): Promise<void> {
  // Fixture rows must never reach a live catalog; only the local/flow env seeds.
  if (process.env.CHECKIN_ENV !== "local") {
    throw new Error(`Refusing to seed the catalog: CHECKIN_ENV is "${process.env.CHECKIN_ENV ?? ""}", not "local".`);
  }
  if (!process.env.CATALOG_DATABASE_URL) {
    throw new Error("CATALOG_DATABASE_URL is not set — the catalog seed needs a database.");
  }
  const db = getPrisma();
  const repo = createCatalogRepository(db);
  const refRepo = createItemReferenceRepository(db);

  await initDb();

  const category =
    (await db.category.findFirst({ where: { letter: "N" } })) ??
    (await repo.createCategory({ name: "Electronics", letter: "N" }));

  const subcategory =
    (await db.subcategory.findFirst({ where: { categoryId: category.id, number: 10 } })) ??
    (await repo.createSubcategory({ name: "Control System", number: 10, categoryId: category.id }));

  async function ensureItem(name: string): Promise<string> {
    const existing = await db.item.findFirst({ where: { name } });
    if (existing) return existing.gtin13;
    const created = await createItem({
      name,
      categoryId: category.id,
      subcategoryId: subcategory.id,
      usageBehavior: "Durable",
      createdByUserId: 0,
      createdByUsername: "seed",
    });
    return created.gtin13;
  }

  const roborioGtin = await ensureItem("Roborio v2");
  await ensureItem("Power Distribution Hub");

  const hasRef = await db.itemReference.findFirst({ where: { gtin13: roborioGtin, partNumber: "am-3455" } });
  if (!hasRef) {
    await refRepo.createItemReference({
      gtin13: roborioGtin,
      partNumber: "am-3455",
      manufacturer: "AndyMark",
      createdByUserId: 0,
      createdByUsername: "seed",
    });
  }

  console.log("🌱 Catalog seed complete: category N/Electronics, subcategory 10/Control System, 2 items, 1 reference.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await getPrisma().$disconnect();
  });
