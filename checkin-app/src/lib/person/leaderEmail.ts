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
