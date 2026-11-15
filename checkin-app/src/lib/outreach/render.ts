import prisma from "@/lib/prisma";
import { config } from "@/lib/config";
import { nextBoundary } from "@/lib/membership/renewal";
import { substituteTokens, findUnknownTokens } from "@/lib/outreach/tokens";

export { findUnknownTokens };

export type EmailType = "opening" | "reminder";

/** The board's current subject/body for one campaign template (BoardSettings singleton). */
export async function loadTemplate(emailType: EmailType): Promise<{ subject: string; body: string }> {
    const settings = await prisma.boardSettings.findUnique({
        where: { id: 1 },
        select: {
            outreachOpeningSubject: true,
            outreachOpeningBody: true,
            outreachReminderSubject: true,
            outreachReminderBody: true,
        },
    });
    return emailType === "opening"
        ? { subject: settings?.outreachOpeningSubject ?? "", body: settings?.outreachOpeningBody ?? "" }
        : { subject: settings?.outreachReminderSubject ?? "", body: settings?.outreachReminderBody ?? "" };
}

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

export interface RenderContext {
    name: string;
    /** Resolved via {@link resolveBoundary} — computed ONCE per send, not per item. */
    boundary: Date;
}

/**
 * Render one recipient's subject+html from the board's template. `{{actionWord}}` is
 * always "renew": outreach goes only to member households.
 */
export function renderOutreachEmail(
    subjectTemplate: string,
    bodyTemplate: string,
    ctx: RenderContext,
): { subject: string; html: string } {
    const tokenCtx = {
        name: ctx.name,
        deadline: ctx.boundary.toISOString().slice(0, 10),
        actionWord: "renew",
        actionLink: `${config.baseUrl()}/membership`,
    };
    return { subject: substituteTokens(subjectTemplate, tokenCtx), html: substituteTokens(bodyTemplate, tokenCtx) };
}
