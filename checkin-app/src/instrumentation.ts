/**
 * Next.js server-boot hook. Runs once per server process before requests.
 * Used to wire the global-catalog library runtime (#1286 §3) — Node runtime
 * only (it pulls in next-auth + Prisma).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { configureCatalogRuntime } = await import("@/lib/catalog/configure");
  configureCatalogRuntime();
}
