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
import { configureCatalog, orgEventService } from "@checkin/global-catalog";
import type { CatalogPrincipal, OrgEventConsumer, OrgEventRecord, OrgIdentity } from "@checkin/global-catalog";
import type { Session } from "next-auth";

/**
 * checkin is inherently single-org (#1286 §6). The org identity is a row in
 * checkin's own `Org` registry table, seeded with this stable well-known id.
 * The library never reaches cross-DB into this table — checkin reads it and
 * injects the identity.
 */
const TREEHOUSE_ORG_ID = "treehouse";
let cachedOrg: OrgIdentity | undefined;

/**
 * The signed-in user, or null for any session `authenticateRequest` would refuse: no positive
 * integer id, a denied household, or a caller the staging gate turns away. Every library adapter
 * builds its principal from this, so no library sees a session checkin itself rejects.
 */
export async function sessionUser(): Promise<Session["user"] | null> {
  // Lazy: importing auth-options at boot would crash a Google-credless boot.
  const [{ getServerSession }, { authOptions }, { config, isStagingAccessAllowed }] = await Promise.all([
    import("next-auth"),
    import("@/lib/auth-options"),
    import("@/lib/config"),
  ]);
  const user = (await getServerSession(authOptions))?.user;
  if (!user || !Number.isInteger(user.id) || user.id <= 0 || user.denied) return null;
  if (config.isStaging() && !isStagingAccessAllowed(user)) return null;
  return user;
}

/** The signed-in person as a library principal; null for any session checkin refuses. */
export async function getPrincipal(): Promise<CatalogPrincipal | null> {
  const user = await sessionUser();
  return user ? { id: user.id, name: user.name ?? null } : null;
}

/**
 * Resolved on first use inside a request, never at boot (boot stays DB-free).
 * Only a found row is cached; a DB error or missing row throws, so the request
 * fails rather than running as a guessed org. Every checkin-hosted library
 * receives this same accessor, so all stamp the same org id.
 */
export async function getOrg(): Promise<OrgIdentity> {
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

/** S5 replay read, bound into each consumer library's event-source port. */
export function catalogEventsSince(orgId: string, afterId: number): Promise<OrgEventRecord[]> {
  return orgEventService.eventsSince(orgId, afterId);
}

/**
 * The S5 consumers the catalog calls after each commit that wrote events. Each library parses
 * the events, applies them and keeps its own cursor; loaded on first event, never at boot.
 */
const orgEventConsumers: Record<string, OrgEventConsumer> = {
  localInventory: {
    async onOrgEvents(events) {
      await (await import("@checkin/local-inventory")).orgEventConsumer.onOrgEvents(events);
    },
  },
  expense: {
    async onOrgEvents(events) {
      const { consumeCatalogEvent } = await import("@checkin/expense");
      for (const event of events) await consumeCatalogEvent(event);
    },
  },
  workflowMapping: {
    async onOrgEvents(events) {
      await (await import("@checkin/workflow-mapping")).orgEventConsumer.onOrgEvents(events);
    },
  },
};

export function configureCatalogRuntime(): void {
  configureCatalog({ auth: { getPrincipal }, org: getOrg, orgEventConsumers });
}
