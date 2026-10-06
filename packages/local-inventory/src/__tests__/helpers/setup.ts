import { beforeEach } from "vitest";
import { resetDb } from "./db";

export function useIntegrationSetup(): void {
  // Only register DB hooks when a Postgres URL is present. Without Docker there's no DB: the
  // suites that call this are describeDb.skip, so registering resetDb here would just
  // throw in beforeEach for nothing.
  if (!process.env.LOCAL_INVENTORY_DATABASE_URL) return;
  beforeEach(() => resetDb());
}
