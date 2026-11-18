import { handler, unauthorized } from "@/security/handler";
import { getKeyVolunteerSelfStatus } from "@/lib/membership/keyVolunteer";

export const dynamic = "force-dynamic";

/** GET /api/membership/key-volunteer — the caller's own Key Volunteer Agreement status. */
export const GET = handler("GET /api/membership/key-volunteer", async ({ auth }) => {
    if (auth.type !== "session") throw unauthorized();
    return { KeyVolunteerSelfStatus: await getKeyVolunteerSelfStatus(auth.user.id) };
});
