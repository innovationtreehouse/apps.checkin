import { calculateAge } from "@/lib/time";

type Age = { dateOfBirth?: Date | string | null; isDeclaredAdult?: boolean | null };
type Member = Age & { id: number; isHouseholdLead?: boolean | null };

/** 18 or over on `today`, an org calendar day: a DOB that says so, or the over-25 declaration. */
export function isAdultAsOf(person: Age, today: Date): boolean {
    if (person.dateOfBirth) return calculateAge(person.dateOfBirth, today) >= 18;
    return !!person.isDeclaredAdult;
}

/** A DOB on file that puts the person under 18 on `today`. An unknown age is not a known minor. */
export function isMinorAsOf(person: Age, today: Date): boolean {
    return !!person.dateOfBirth && calculateAge(person.dateOfBirth, today) < 18;
}

/**
 * Whether the household's lead is asked to make `personId` its second lead (a partner or
 * spouse): the household has exactly one lead and `personId` is an adult who isn't one.
 * `members` includes `personId`; `today` is the org's calendar day.
 */
export function secondLeadQuestionDue(members: Member[], personId: number, today: Date): boolean {
    const person = members.find((m) => m.id === personId);
    if (!person || person.isHouseholdLead || !isAdultAsOf(person, today)) return false;
    return members.filter((m) => m.isHouseholdLead).length === 1;
}
