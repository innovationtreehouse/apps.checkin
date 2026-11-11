// Prisma 7 reads CLI/datasource configuration from this file, not schema.prisma.
// The `datasource` block holds no `url`; the CLI (migrate/db) reads it
// from here, and the runtime client connects via the @prisma/adapter-pg driver adapter
// (see src/db/client.ts). MONITORING_DATABASE_URL points at the dedicated monitoring
// Postgres. `dotenv/config` loads the package-local .env so direct `prisma` invocations
// (not just the `--env-file=.env` npm scripts) resolve the URL.
//
// We read the URL via `process.env` rather than prisma's strict `env()` helper on
// purpose: `env()` throws at config-load time if the var is missing, which would break
// `prisma generate` in a build/CI step that has no database credentials. Generate does
// not need a URL; only the migrate/db commands do, and those fail with a clear Prisma
// error if it is genuinely unset.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.MONITORING_DATABASE_URL,
  },
});
