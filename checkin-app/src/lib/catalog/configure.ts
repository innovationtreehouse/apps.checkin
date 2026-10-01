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

type ApiErrorCtor = new (status: number, message: string) => Error;
let apiErrorCtor: ApiErrorCtor | undefined;

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
 * The library throws its route errors through this; handler() maps an
 * `instanceof ApiResponseError` to its status. ApiResponseError lives in
 * @/security/handler (which transitively imports auth), so it is warmed lazily
 * off the boot path. Before it warms, fall back to a status-carrying Error — this
 * only happens if a route throws before the warm resolves, which does not occur
 * once the process has served any request.
 */
function httpError(status: number, message: string): Error {
  if (apiErrorCtor) return new apiErrorCtor(status, message);
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

export async function configureCatalogRuntime(): Promise<void> {
  // AWAIT the warm here (register() awaits this before Next serves any request),
  // so apiErrorCtor is set before the first request — no cold-start window where
  // a catalog 4xx degrades to 500. The try/catch keeps a credential-less boot
  // (the deploy smoke test, no GOOGLE_CLIENT_ID) from crashing on the
  // auth-options throw in @/security/handler's import chain.
  try {
    const m = await import("@/security/handler");
    apiErrorCtor = m.ApiResponseError as unknown as ApiErrorCtor;
  } catch {
    /* credential-less boot (smoke test) — handler()/auth load per-request there */
  }
  configureCatalog({ auth: { getPrincipal }, org: () => TREEHOUSE_ORG, httpError });
}
