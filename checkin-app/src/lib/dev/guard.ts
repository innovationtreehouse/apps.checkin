import { getServerSession } from "next-auth/next";
import { notFound } from "next/navigation";
import { config, ORG_DOMAIN } from "@/lib/config";
import { authOptions } from "@/lib/auth-options";

/**
 * The dev-instance security fence, shared by every dev-only server action and the ledger reader
 * (docs/ops/dev-instance.md, "The dev fence"). It mirrors the persona-mint gate:
 *
 *   - prod  → notFound() always. Dead in production by construction.
 *   - dev   → the caller's CURRENT session must be a verified @innovationtreehouse.org member
 *             (checked here in the action body, never via a build flag or client input).
 *   - local → relaxed: there is no Google identity on a laptop, so any session (or none) passes.
 *
 * Returns the REAL human behind the request (the inert `impersonatedBy` if impersonating, else the
 * signed-in email) for ledger attribution — never a persona's identity.
 *
 * This is defense-in-depth, not the only control: the dev middleware already org-gates these routes
 * and structural data isolation (docs/ops/dev-instance.md, "Data isolation") means even a forged
 * session cannot reach prod data. It is the third fence.
 */
export async function assertDevActor(): Promise<string> {
    // notFound() (404) rather than 403 keeps the dev surface invisible, matching /api/auth/dev-personas.
    if (config.isProd()) notFound();

    const session = await getServerSession(authOptions);
    const user = session?.user;
    const real = user?.impersonatedBy ?? user?.email ?? null;

    if (config.checkinEnv() === "dev") {
        const verifiedOrg = user?.hd === ORG_DOMAIN && user?.emailVerified === true;
        if (!real || !verifiedOrg) notFound();
        return real;
    }

    // local: offline, no Google — attribute to the real human if known, else a generic marker.
    return real ?? "local";
}
