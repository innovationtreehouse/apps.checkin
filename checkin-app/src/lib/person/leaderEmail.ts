import { calculateAge } from "@/lib/time";

/** Board ruling B15: program leaders see a participant's own email from age 13. */
export const LEADER_EMAIL_MIN_AGE = 13;

/** An unknown date of birth fails closed: the email stays hidden. */
export function leaderMaySeeEmail(dateOfBirth: Date | string | null): boolean {
    return !!dateOfBirth && calculateAge(dateOfBirth) >= LEADER_EMAIL_MIN_AGE;
}

/**
 * A roster participant as the route ships it: the date of birth is read only to
 * judge the email and never leaves; the email is withheld from a program leader
 * while the participant is under 13.
 */
export function rosterPerson<P extends { email: string | null; dateOfBirth: Date | null }>(
    { dateOfBirth, ...person }: P,
    viewerIsLeader: boolean,
): Omit<P, "dateOfBirth"> {
    return viewerIsLeader && !leaderMaySeeEmail(dateOfBirth) ? { ...person, email: null } : person;
}

/** The enrolled participants whose email the viewer may not see, wherever the response lists them. */
export function emailWithheldParticipants(
    participants: { personId: number; person: { dateOfBirth: Date | null } }[],
    viewerIsLeader: boolean,
): Set<number> {
    return new Set(viewerIsLeader
        ? participants.filter(p => !leaderMaySeeEmail(p.person.dateOfBirth)).map(p => p.personId)
        : []);
}

/** Nulls the email of a person the rule hides, wherever the response lists them. */
export function withholdEmail<P extends { id: number; email: string | null }>(person: P, emailWithheldFrom: ReadonlySet<number>): P {
    return emailWithheldFrom.has(person.id) ? { ...person, email: null } : person;
}

/**
 * A roster household as the route ships it: an enrolled participant listed among
 * its leads keeps the same email rule as on their own roster row. Everyone else
 * listed is a guardian and keeps their email.
 */
export function rosterHousehold<M extends { id: number; email: string | null }, H extends { householdMembers: M[] }>(
    household: H,
    emailWithheldFrom: ReadonlySet<number>,
): H {
    return {
        ...household,
        householdMembers: household.householdMembers.map(m => withholdEmail(m, emailWithheldFrom)),
    };
}
