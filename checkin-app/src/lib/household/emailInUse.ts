import { isValidEmail } from "@/lib/emergencyContacts/identity";
import { normalizeEmail } from "@/lib/prismaEmailNormalize";
import { isPrismaError, uniqueViolationFields } from "@/lib/prismaUniqueViolation";

/** Says what happens if the address is held, never whether it is. */
export const EMAIL_IN_USE_REFUSAL = "We couldn't add this member with that email. If they already have an account, they'll be linked automatically when they first sign in with Google using that email.";

const isBlankEmail = (email: unknown): boolean =>
    email === undefined || email === null || (typeof email === "string" && normalizeEmail(email) === "");

/** Edit forms resend the whole record, so a stored address sent back stays saveable however it reads. */
export function isBadEmailChange(email: unknown, stored: string | null): boolean {
    if (isBlankEmail(email)) return false;
    if (typeof email !== "string") return true;
    return normalizeEmail(email) !== normalizeEmail(stored ?? "") && !isValidEmail(email);
}

/** A collision on Person.email from writing a real address; any other collision is not this refusal's to explain. */
export function isEmailInUseError(error: unknown, email: unknown): boolean {
    return isPrismaError(error, "P2002")
        && Boolean(uniqueViolationFields(error)?.includes("email"))
        && !isBlankEmail(email);
}
