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
import prisma from "@/lib/prisma";

/**
 * checkin is inherently single-org (#1286 §6). The org identity is a row in
 * checkin's own `Org` registry table (seeded with this stable well-known id),
 * read once at boot and injected as the accessor. The seam is what matters:
 * multi-org later resolves the current org per request here, no library change.
 * The library never reaches cross-DB into this table — checkin reads it and
 * injects the identity.
 */
const TREEHOUSE_ORG_ID = "treehouse";
const FALLBACK_ORG: OrgIdentity = { id: TREEHOUSE_ORG_ID, name: "Treehouse" };

async function getPrincipal(): Promise<CatalogPrincipal | null> {
  const session = await getServerSession(authOptions);
  const user = session?.user;
  if (!user || typeof user.id !== "number") return null;
  return { id: user.id, name: user.name ?? null };
}

/**
 * The org accessor is synchronous and per-request, so resolve the single-org
 * row once at boot and close over it. A DB not yet seeded falls back to the
 * well-known id/name — identical to the pre-registry constant, so boot never
 * crashes and stamped org_ids stay consistent.
 */
async function loadOrg(): Promise<OrgIdentity> {
  const row = await prisma.org.findUnique({
    where: { id: TREEHOUSE_ORG_ID },
    select: { id: true, name: true },
  });
  if (!row) {
    console.warn(
      `[catalog] Org row "${TREEHOUSE_ORG_ID}" not found — falling back to the well-known constant. Seed the Org registry.`,
    );
    return FALLBACK_ORG;
  }
  return row;
}

export async function configureCatalogRuntime(): Promise<void> {
  const org = await loadOrg();
  configureCatalog({
    auth: { getPrincipal },
    org: () => org,
    httpError: (status, message) => new ApiResponseError(status, message),
  });
}
