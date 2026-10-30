import type { Prisma } from "@/generated/prisma/client";
import { withTx, type DbClient } from "@/lib/db-client";
import { addHouseholdLead } from "@/lib/household/leads";
import { mintPersonId } from "@/lib/person/mintId";
import { familyName } from "@/lib/person/name";

export type OwnHouseholdPerson = Omit<Prisma.PersonUncheckedCreateInput, "id" | "householdId"> & { name: string };

/**
 * Creates a person in a new household of their own, which they lead. The household has no
 * org membership, so the person is a non-member until one is granted.
 */
export async function createInOwnHousehold(db: DbClient, data: OwnHouseholdPerson) {
    const family = familyName(data.name);
    // The household is its own statement: an explicit `id` is only accepted by Prisma's
    // unchecked create input, which has no room for a nested relation create.
    const person = await withTx(db, async (tx) => {
        const household = await tx.household.create({
            data: { name: family ? `${family} Household` : "Household" },
        });
        return tx.person.create({ data: { ...data, id: await mintPersonId(tx), householdId: household.id } });
    });
    await addHouseholdLead(db, person.householdId, person.id);
    return person;
}

/** Adds a non-member adult known only by name, declared an adult by whoever adds them. */
export async function addNonMemberAdult(db: DbClient, name: string): Promise<{ id: number; name: string }> {
    const person = await createInOwnHousehold(db, { name: name.trim(), isDeclaredAdult: true });
    return { id: person.id, name: person.name };
}
