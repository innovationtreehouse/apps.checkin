import type { Prisma } from "@/generated/prisma/client";
import { EMAIL_LOCK_SELECT } from "@/lib/person/emailLock";

/**
 * Fields of a household peer's Person row that are safe to send to any
 * other member of the same household (including youth) — i.e. what the
 * my-household member cards and the program-enrollment picker actually
 * render. Excludes INTERNAL-tier fields (role flags, googleId, emailVerified,
 * lastBackgroundCheck, waiverSignedBy, notificationSettings, ...) that a
 * household peer has no business seeing.
 */
export const HOUSEHOLD_PEER_SELECT = {
    id: true,
    name: true,
    // The name the member goes by, printed on their badge. @sensitivity:public, same
    // as `name`, and a household lead edits it from the my-household cards.
    nickname: true,
    email: true,
    phone: true,
    dateOfBirth: true,
    // Deliberate exception: isDeclaredAdult is @sensitivity:internal, but a household
    // peer legitimately needs it to render each member's age badge / pre-fill the edit
    // form (my-household). It's an age-status flag, not a role/audit/security flag.
    isDeclaredAdult: true,
    // Collected per-person at membership intake; household peers view/edit it on
    // the my-household cards. Same @sensitivity:personal tier as name/email/phone.
    allergies: true,
    // Leadership. @sensitivity:public — already surfaced as the "Household
    // Lead" badge on the my-household cards; peers legitimately see who leads.
    isHouseholdLead: true,
} satisfies Prisma.PersonSelect;

/** The peer projection plus the email-lock inputs, mapped to an `emailLocked` boolean before it leaves. */
export const HOUSEHOLD_PEER_WITH_EMAIL_LOCK_SELECT = {
    ...HOUSEHOLD_PEER_SELECT,
    ...EMAIL_LOCK_SELECT,
} satisfies Prisma.PersonSelect;
