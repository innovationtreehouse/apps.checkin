import { beforeAll, beforeEach } from "vitest";
import { initDb } from "@/lib/db/index";
import { resetDb } from "./db";

export function useIntegrationSetup(): void {
  // Only register DB hooks when a Postgres URL is present. Without Docker there's no DB: the
  // suites that call this are describeDb.skip, so registering initDb/resetDb here would just
  // throw in beforeAll for nothing.
  if (!process.env.LOCAL_INVENTORY_DATABASE_URL) return;
  beforeAll(() => initDb());
  beforeEach(() => resetDb());
}
