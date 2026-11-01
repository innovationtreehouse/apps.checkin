import { handler, unauthorized } from "@/security/handler";
import { bumpKeyVolunteerAgreementVersion } from "@/lib/membership/keyVolunteer";

export const dynamic = "force-dynamic";

/**
 * POST /api/settings/membership/key-volunteer-version — the Board marks the Key
 * Volunteer Agreement materially changed. Every Key Volunteer is asked to sign
 * the new version; nobody loses a role.
 */
export const POST = handler("POST /api/settings/membership/key-volunteer-version", async ({ auth }) => {
    if (auth.type !== "session") throw unauthorized();
    return { KeyVolunteerVersionBump: await bumpKeyVolunteerAgreementVersion(auth.user.id) };
});
