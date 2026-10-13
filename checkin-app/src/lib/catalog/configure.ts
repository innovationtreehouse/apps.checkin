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
 * checkin is single-org (#1286 §6); the accessor returns a constant until the
 * Org registry table lands (track 6 seeds the Treehouse row with this id).
 */
const TREEHOUSE_ORG: OrgIdentity = { id: "treehouse", name: "Treehouse" };

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

export function configureCatalogRuntime(): void {
  configureCatalog({ auth: { getPrincipal }, org: () => TREEHOUSE_ORG });
}
