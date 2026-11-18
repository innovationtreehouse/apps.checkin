import prisma from "@/lib/prisma";
import { config } from "@/lib/config";
import { nextBoundary } from "@/lib/membership/renewal";
import type { TemplateCtx, TemplateKey } from "@/lib/email-templates/registry";

export type EmailType = "opening" | "reminder";

/** The template each campaign sends. */
export const OUTREACH_KEY = { opening: "outreach.opening", reminder: "outreach.reminder" } as const satisfies Record<EmailType, TemplateKey>;

/** Thrown by {@link resolveBoundary} when the board hasn't configured the membership-year
 * boundary. `{{deadline}}` has nothing to render, so create-send blocks on this, surfacing
 * one clear error in the confirm dialog rather than a per-item failure mid-drain. */
export class BoundaryNotSetError extends Error {
    constructor() {
        super("Set the membership-year boundary (Settings → Membership) before sending.");
        this.name = "BoundaryNotSetError";
    }
}

/** The next occurrence of the board's configured membership-year boundary, or throws. */
export async function resolveBoundary(now: Date): Promise<Date> {
    const settings = await prisma.boardSettings.findUnique({
        where: { id: 1 },
        select: { orgMembershipYearBoundary: true },
    });
    if (!settings?.orgMembershipYearBoundary) throw new BoundaryNotSetError();
    return nextBoundary(settings.orgMembershipYearBoundary, now);
}

/** One recipient's token values; `{{deadline}}` is the boundary's date, YYYY-MM-DD. */
export function outreachCtx(name: string, boundary: Date): TemplateCtx<"outreach.opening"> {
    return { name, deadline: boundary.toISOString().slice(0, 10), actionLink: `${config.baseUrl()}/membership` };
}
