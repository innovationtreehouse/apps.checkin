import { handler, ApiResponseError, badRequest, unauthorized } from "@/security/handler";
import { unarchiveHousehold } from "@/lib/household/archiveAction";
import { ServiceError } from "@checkin/component-kit";

export const dynamic = "force-dynamic";

/** POST /api/membership-ops/households/[id]/unarchive — the Board clears the household's archivedAt. */
export const POST = handler<{ id: string }>("POST /api/membership-ops/households/[id]/unarchive", async ({ auth, params }) => {
    if (auth.type !== "session") throw unauthorized();
    const id = Number(params.id);
    if (!Number.isInteger(id)) throw badRequest("Invalid household ID");
    try {
        return { Household: await unarchiveHousehold(id, auth.user.id) };
    } catch (error) {
        if (error instanceof ServiceError) throw new ApiResponseError(error.status, error.message);
        throw error;
    }
});
