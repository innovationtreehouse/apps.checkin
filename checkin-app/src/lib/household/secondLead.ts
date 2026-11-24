import { calculateAge, orgCalendarDay } from "@/lib/time";

type Age = { dateOfBirth?: Date | string | null; isDeclaredAdult?: boolean | null };
type Member = Age & { id: number; isHouseholdLead?: boolean | null };

/** 18 or over as of `now`'s calendar day in the org's zone: a DOB that says so, or the over-25 declaration. */
export function isAdultAsOf(person: Age, now: Date = new Date()): boolean {
    if (person.dateOfBirth) return calculateAge(person.dateOfBirth, orgCalendarDay(now)) >= 18;
    return !!person.isDeclaredAdult;
}

/** A DOB on file that puts the person under 18 as of `now`. An unknown age is not a known minor. */
export function isMinorAsOf(person: Age, now: Date = new Date()): boolean {
    return !!person.dateOfBirth && calculateAge(person.dateOfBirth, orgCalendarDay(now)) < 18;
}

/**
 * Whether the household's lead is asked to make `personId` its second lead (a partner or
 * spouse): the household has exactly one lead and `personId` is an adult who isn't one.
 * `members` includes `personId`.
 */
export function secondLeadQuestionDue(members: Member[], personId: number, now: Date = new Date()): boolean {
    const person = members.find((m) => m.id === personId);
    if (!person || person.isHouseholdLead || !isAdultAsOf(person, now)) return false;
    return members.filter((m) => m.isHouseholdLead).length === 1;
}
