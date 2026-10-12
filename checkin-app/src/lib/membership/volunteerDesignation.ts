import { canonicalizeEmail } from "@/lib/emailNormalize";
import { type DbClient } from "@/lib/db-client";

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

/** Shown when a member-side write names a designated address; says nothing about why. */
export const DESIGNATED_EMAIL_REFUSAL = "That email address can't be added here. Contact the board to add this person.";
