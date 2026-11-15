import { sharesHousehold } from "@/lib/conflictOfInterest";
import { canonicalizeEmail } from "@/lib/emailNormalize";
import { normalizePhone } from "@/lib/phone";

/** Contact details of one person in the actor's household. */
export interface HouseholdContact {
    email: string | null;
    phone: string | null;
}

/** The trusted adult's identity facts the conflict rule reads. */
export interface TrustedAdultIdentity {
    personId: number | null | undefined;
    personHouseholdId: number | null | undefined;
    email: string | null | undefined;
    phone: string | null | undefined;
}

/** Digits only, with a leading US country code dropped, so "+1 555…" matches "555…". */
function phoneKey(phone: string | null | undefined): string {
    const d = normalizePhone(phone);
    return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
}

/**
 * Whether the trusted adult belongs to the actor's household: by the linked
 * person's household when there is one, otherwise by email or phone matching
 * someone in the actor's household. Never by name.
 */
function adultInActorHousehold(
    actorHouseholdId: number | null | undefined,
    actorHouseholdContacts: readonly HouseholdContact[],
    adult: TrustedAdultIdentity,
): boolean {
    if (adult.personId != null) return sharesHousehold(actorHouseholdId, adult.personHouseholdId);
    const email = adult.email?.trim() ? canonicalizeEmail(adult.email) : null;
    const phone = phoneKey(adult.phone) || null;
    return actorHouseholdContacts.some(
        (c) =>
            (email !== null && c.email != null && canonicalizeEmail(c.email) === email) ||
            (phone !== null && phoneKey(c.phone) === phone),
    );
}

/**
 * Conflict-of-interest rule for trusted-adult reviews. A board member may not decide
 * a review for their own household, one where they are the trusted adult, or one
 * whose trusted adult is in their household (their spouse, say), whichever family
 * asked. Pure, so the server (decideReview, overrideReview) and the board review
 * page gate off the same rule. Ids are person ids.
 */
export function isTrustedAdultConflict(args: {
    actorParticipantId: number | null | undefined;
    actorHouseholdId: number | null | undefined;
    actorHouseholdContacts: readonly HouseholdContact[];
    taHouseholdId: number | null | undefined;
    adult: TrustedAdultIdentity;
    /** A pending change's proposed contact, which approval would make the adult's own. */
    proposed?: HouseholdContact | null;
}): boolean {
    const { actorParticipantId, actorHouseholdId, actorHouseholdContacts, taHouseholdId, adult, proposed } = args;
    return (
        sharesHousehold(actorHouseholdId, taHouseholdId) ||
        (actorParticipantId != null && actorParticipantId === adult.personId) ||
        adultInActorHousehold(actorHouseholdId, actorHouseholdContacts, adult) ||
        (proposed != null && adultInActorHousehold(actorHouseholdId, actorHouseholdContacts, { ...adult, ...proposed }))
    );
}

/** True when only a name identifies the adult, so the household check cannot run. */
export function cannotConfirmNoConflict(adult: TrustedAdultIdentity): boolean {
    return adult.personId == null && !adult.email?.trim() && !phoneKey(adult.phone);
}
