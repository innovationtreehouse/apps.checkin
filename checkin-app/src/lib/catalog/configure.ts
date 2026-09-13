/**
 * Wire the global-catalog library into checkin (#1286 §3/§6). Called once at
 * server boot (instrumentation.ts). The library never imports checkin — this is
 * the one place the dependency arrow is satisfied by injection:
 *   - auth.getPrincipal → the checkin next-auth session (person id + name),
 *   - org → the Treehouse org identity (see the accessor note below),
 *   - httpError → checkin's ApiResponseError, so a library-thrown error is
 *     rendered by handler() with its status + message.
 *
 * The catalog Prisma client is the library's own (`@inventory/global-catalog`
 * reads CATALOG_DATABASE_URL, which checkin's env provides), so no `db` is
 * injected here.
 */
import { getServerSession } from "next-auth";
import { configureCatalog } from "@inventory/global-catalog/runtime";
import type { CatalogPrincipal, OrgIdentity } from "@inventory/global-catalog/contract";
import { authOptions } from "@/lib/auth-options";
import { ApiResponseError } from "@/security/handler";

/**
 * checkin is inherently single-org (#1286 §6). Until the `Org` registry table
 * lands (track 6 seeds the Treehouse row with THIS id), the accessor returns a
 * constant. The seam is what matters: multi-org later resolves the current org
 * per request here, no library change.
 * ponytail: constant accessor, not an env scalar or a table read — Track 6
 * repoints it at the seeded Org row using this same well-known id.
 */
const TREEHOUSE_ORG: OrgIdentity = { id: "treehouse", name: "Treehouse" };

async function getPrincipal(): Promise<CatalogPrincipal | null> {
  const session = await getServerSession(authOptions);
  const user = session?.user;
  if (!user || typeof user.id !== "number") return null;
  return { id: user.id, name: user.name ?? null };
}

export function configureCatalogRuntime(): void {
  configureCatalog({
    auth: { getPrincipal },
    org: () => TREEHOUSE_ORG,
    httpError: (status, message) => new ApiResponseError(status, message),
  });
}
