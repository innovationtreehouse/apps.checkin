import type { DbClient } from "@/lib/db-client";
import { isOrgAccount } from "@/lib/orgAccount";

export const TREEHOUSE_HOUSEHOLD_REFUSAL =
    "This household belongs to a Treehouse account, which is not a member family. Nobody can be added, moved or merged into it.";

export const TREEHOUSE_SIGN_IN_REFUSAL =
    "A staff member uses a separate Treehouse account, so an address on the Treehouse domain can't be given to someone in a family's household.";

/** A household holding a person with an org-domain email belongs to that Treehouse account. */
export function holdsTreehouseAccount(people: readonly { email: string | null }[]): boolean {
    return people.some((p) => isOrgAccount({ email: p.email }));
}

export async function isTreehouseHousehold(db: DbClient, householdId: number): Promise<boolean> {
    const people = await db.person.findMany({
        where: { householdId, email: { not: null } },
        select: { email: true },
    });
    return holdsTreehouseAccount(people);
}

/** Whether giving `email` to someone in this household would put a Treehouse account in a family's household. */
export async function putsTreehouseSignInInFamily(db: DbClient, householdId: number, email: unknown): Promise<boolean> {
    return typeof email === "string" && isOrgAccount({ email }) && !(await isTreehouseHousehold(db, householdId));
}

/** Whether a new member with `email` would bring a Treehouse account into a household; it never may. */
export function joinsWithTreehouseSignIn(email: unknown): boolean {
    return typeof email === "string" && isOrgAccount({ email });
}

/** A person was refused a place in a Treehouse account's household. */
export class TreehouseHouseholdError extends Error {
    readonly status = 409;
    constructor() {
        super(TREEHOUSE_HOUSEHOLD_REFUSAL);
    }
}
