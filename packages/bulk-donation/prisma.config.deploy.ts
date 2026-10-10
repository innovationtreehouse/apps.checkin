// Prisma config for the DEPLOY IMAGE only — the Dockerfile copies this into the runner
// stage as prisma.config.ts (the real prisma.config.ts is not shipped). The bulk-donation
// `prisma migrate deploy` runs in the migrate ECS task via the image's prisma CLI, so this
// file must have ZERO imports: `dotenv` and `prisma/config` are not resolvable there. A
// plain default export is fine — the config loader passes it through defineConfig itself.
// BULK_DONATION_DATABASE_URL comes from ECS Secrets Manager injection (mirrors
// checkin-app/prisma.config.deploy.ts and packages/global-catalog/prisma.config.deploy.ts).
const config = {
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["BULK_DONATION_DATABASE_URL"],
  },
};

export default config;
