/**
 * Wire the global-catalog library into checkin (#1286 §3/§6), called once at
 * server boot from instrumentation.ts.
 *
 * BOOT-CLEAN: nothing here may EAGERLY import checkin auth. `@/lib/auth-options`
 * (and `@/security/handler`, which imports it transitively) throws at module
 * load when GOOGLE_CLIENT_ID is unset — which is exactly how the deploy smoke
 * test boots the image (placeholder env, no Google creds). So every checkin-side
 * dependency is loaded lazily, off the boot path; the app must boot without them.
 */
import { configureCatalog } from "@inventory/global-catalog";
import type { CatalogPrincipal, OrgIdentity } from "@inventory/global-catalog";

/**
 * checkin is inherently single-org (#1286 §6). The org identity is a row in
 * checkin's own `Org` registry table, seeded with this stable well-known id.
 * The library never reaches cross-DB into this table — checkin reads it and
 * injects the identity.
 */
const TREEHOUSE_ORG_ID = "treehouse";
let cachedOrg: OrgIdentity | undefined;

async function getPrincipal(): Promise<CatalogPrincipal | null> {
  // Lazy: importing auth-options at boot would crash a Google-credless boot.
  const [{ getServerSession }, { authOptions }] = await Promise.all([
    import("next-auth"),
    import("@/lib/auth-options"),
  ]);
  const session = await getServerSession(authOptions);
  const user = session?.user;
  if (!user || typeof user.id !== "number") return null;
  return { id: user.id, name: user.name ?? null };
}

/**
 * Resolved on first use inside a request, never at boot (boot stays DB-free).
 * Only a found row is cached; a DB error or missing row throws, so the request
 * fails rather than running as a guessed org.
 */
async function getOrg(): Promise<OrgIdentity> {
  if (cachedOrg) return cachedOrg;
  const { default: prisma } = await import("@/lib/prisma");
  const row = await prisma.org.findUnique({
    where: { id: TREEHOUSE_ORG_ID },
    select: { id: true, name: true },
  });
  if (!row) throw new Error(`Org row "${TREEHOUSE_ORG_ID}" not found — seed the Org registry`);
  cachedOrg = row;
  return row;
}

export function configureCatalogRuntime(): void {
  configureCatalog({ auth: { getPrincipal }, org: getOrg });
}
