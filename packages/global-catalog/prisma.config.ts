// Prisma 7 moved CLI/datasource configuration out of schema.prisma into this file.
// The `url` no longer lives in the `datasource` block; the CLI (migrate/db push) reads
// it from here, while the runtime client connects via the @prisma/adapter-pg driver
// adapter (see src/db/index.ts). CATALOG_DATABASE_URL is this app's domain-specific
// Postgres URL (never a bare DATABASE_URL — that convention prevents cross-app clashes). We
// read it via `process.env` rather than prisma's strict `env()` helper so `prisma generate`
// doesn't throw in a build/CI step that has no URL — generate doesn't need it; only migrate/db do.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.CATALOG_DATABASE_URL,
  },
});
