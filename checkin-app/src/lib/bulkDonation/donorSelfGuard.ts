import type { InKindDonor } from "@checkin/bulk-donation";
import type { DbClient } from "@/lib/db-client";
import type { AuthResult } from "@/types/auth";
import { resolveActorHouseholdId } from "@/lib/conflictOfInterest";
import { recordSelfGrantRefusal } from "@/lib/membership/selfGrantGuard";
import { LIVE_PERSON } from "@/lib/person/filters";
import { forbidden } from "@/security/handler";
import { surname } from "@/lib/bulkDonation/donorSurname";

export const OWN_HOUSEHOLD_DONOR_MESSAGE =
  "You cannot record a gift from yourself or your own household. Someone outside your household must record it.";

/**
 * Throws 403 when the donor may be the recorder or someone in the recorder's
 * household. Donors are names, not linked people, so a donor whose last name
 * matches anyone in the household counts as the household. An unresolved
 * recorder or a donor with no usable last name is refused too (fail closed).
 * Each refusal writes a SelfGrantRefusal audit row with no donor field in it.
 */
export async function refuseOwnHouseholdDonor(db: DbClient, auth: AuthResult, donor: InKindDonor): Promise<void> {
  const actorId = auth.type === "session" ? auth.user.id : null;
  const householdId = actorId === null ? null : await resolveActorHouseholdId(db, actorId);

  let reason: "actor_household_unresolved" | "own_household" | null = null;
  let affectedEntityId = actorId;
  if (householdId === null) {
    reason = "actor_household_unresolved";
  } else {
    const donorSurname = surname(donor.lastName);
    const people = await db.person.findMany({ where: { householdId, ...LIVE_PERSON }, select: { id: true, name: true } });
    const match = people.find((p) => surname(p.name) === donorSurname);
    if (!donorSurname || match) {
      reason = "own_household";
      affectedEntityId = match?.id ?? actorId;
    }
  }

  if (reason === null) return;
  if (actorId !== null) {
    await recordSelfGrantRefusal(db, {
      actorId,
      affectedEntityId: affectedEntityId ?? actorId,
      newData: { reason, table: "ManualInKindDonation" },
    });
  }
  throw forbidden(OWN_HOUSEHOLD_DONOR_MESSAGE);
}
