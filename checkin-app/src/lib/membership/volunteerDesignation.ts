import { canonicalizeEmail } from "@/lib/emailNormalize";
import { type DbClient } from "@/lib/db-client";
import { getEmailSenderIdentity } from "@/lib/emailIdentity";
import { howToReachBoard } from "@/lib/person/signInEmail";

/**
 * True when `email` canonically matches a stored volunteer designation. A
 * designated address is set on a person only by the board, so member-side email
 * writes refuse it.
 */
export async function isDesignatedEmail(db: DbClient, email: string): Promise<boolean> {
    const key = canonicalizeEmail(email);
    // ponytail: full scan of a small board-curated table; add an indexed canonical column if it grows.
    const designations = await db.volunteerDesignation.findMany({ select: { email: true } });
    return designations.some((d) => canonicalizeEmail(d.email) === key);
}

/** Shown when a member-side write names a designated address: says how to get it set, not why. */
export function designatedEmailRefusal(boardReplyTo?: string | null): string {
    return `That email address can't be added here. To use it, ${howToReachBoard(boardReplyTo)}.`;
}

/** designatedEmailRefusal with the board's configured reply-to address. */
export async function designatedEmailRefusalForBoard(): Promise<string> {
    const { replyTo } = await getEmailSenderIdentity();
    return designatedEmailRefusal(replyTo?.[0]);
}
