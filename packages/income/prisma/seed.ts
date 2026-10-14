/**
 * Income dev/test seed: one OPEN NO_DEPOSIT reconciliation row the screens and flow tests
 * exercise without a store mirror or QuickBooks. Idempotent, so a re-run is safe.
 */
import * as dotenv from "dotenv";
import { getPrisma } from "../src/db";
import { seedIncomeDev } from "../src/seed";

dotenv.config();

// The org id the host injects (checkin's Org registry row); rows stamped with any other id
// are invisible to the routes.
const ORG_ID = "treehouse";

async function main(): Promise<void> {
  // Fixture rows must never reach a live ledger; only the local/flow env seeds.
  if (process.env.CHECKIN_ENV !== "local") {
    throw new Error(`Refusing to seed income: CHECKIN_ENV is "${process.env.CHECKIN_ENV ?? ""}", not "local".`);
  }
  if (!process.env.INCOME_DATABASE_URL) {
    throw new Error("INCOME_DATABASE_URL is not set: the income seed needs a database.");
  }
  await seedIncomeDev(ORG_ID);
  console.log("🌱 Income seed complete: 1 open reconciliation row.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await getPrisma().$disconnect();
  });
