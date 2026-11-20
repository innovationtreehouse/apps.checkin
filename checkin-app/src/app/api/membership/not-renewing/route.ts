import { handler, ApiResponseError, unauthorized } from "@/security/handler";
import type { HandlerContext } from "@/security/handler";
import { isServiceError } from "@checkin/component-kit";
import { markNotRenewing, clearNotRenewing } from "@/lib/membership/notRenewing";

export const dynamic = "force-dynamic";

/**
 * POST /api/membership/not-renewing — a household lead says the household won't
 * renew into the year the next renewal run opens. DELETE takes it back. Both
 * return the household's OrgMembership; the lead check is the service's.
 */
function notRenewingRoute(act: (personId: number) => Promise<unknown>) {
    return async ({ auth }: HandlerContext) => {
        if (auth.type !== "session") throw unauthorized();
        try {
            return { OrgMembership: await act(auth.user.id) };
        } catch (error) {
            if (isServiceError(error)) throw new ApiResponseError(error.status, error.message, error.code);
            throw error;
        }
    };
}

export const POST = handler("POST /api/membership/not-renewing", notRenewingRoute((id) => markNotRenewing(id)));
export const DELETE = handler("DELETE /api/membership/not-renewing", notRenewingRoute(clearNotRenewing));
