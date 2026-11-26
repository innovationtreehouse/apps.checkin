import type { DbClient } from "@/lib/db-client";
import { isOrgAccount } from "@/lib/orgAccount";

export const TREEHOUSE_HOUSEHOLD_REFUSAL =
    "This household belongs to a Treehouse account, which is not a member family. Nobody can be added, moved or merged into it.";

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

/** A person was refused a place in a Treehouse account's household. */
export class TreehouseHouseholdError extends Error {
    readonly status = 409;
    constructor() {
        super(TREEHOUSE_HOUSEHOLD_REFUSAL);
    }
}
