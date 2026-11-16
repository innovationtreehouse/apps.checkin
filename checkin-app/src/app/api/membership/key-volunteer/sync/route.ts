import { handler, unauthorized } from "@/security/handler";
import { syncKeyVolunteerSignature } from "@/lib/membership/keyVolunteer";

export const dynamic = "force-dynamic";

/**
 * POST /api/membership/key-volunteer/sync — called when the signer returns from
 * embedded signing. Pulls the request status from Zoho and records the signature
 * if it is complete, then returns the caller's status.
 */
export const POST = handler("POST /api/membership/key-volunteer/sync", async ({ auth }) => {
    if (auth.type !== "session") throw unauthorized();
    return { KeyVolunteerSelfStatus: await syncKeyVolunteerSignature(auth.user.id) };
});
