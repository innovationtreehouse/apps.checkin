import { cannotConfirmNoConflict, isTrustedAdultConflict, type TrustedAdultIdentity } from "@/lib/trusted-adult/conflict";

const ACTOR = 1;
const ACTOR_HOUSEHOLD = 10;
const OTHER_FAMILY = 20;
const spouse = { email: "Spouse@Example.com", phone: "(555) 234-5678" };

const nameOnly: TrustedAdultIdentity = { personId: null, personHouseholdId: null, email: null, phone: null };

function conflict(adult: Partial<TrustedAdultIdentity>, proposed?: { email: string | null; phone: string | null }) {
    return isTrustedAdultConflict({
        actorParticipantId: ACTOR,
        actorHouseholdId: ACTOR_HOUSEHOLD,
        actorHouseholdContacts: [{ email: "me@example.com", phone: null }, spouse],
        taHouseholdId: OTHER_FAMILY,
        adult: { ...nameOnly, ...adult },
        proposed,
    });
}

describe("isTrustedAdultConflict", () => {
    it("refuses the requesting family's own household and the actor as the adult", () => {
        expect(isTrustedAdultConflict({
            actorParticipantId: ACTOR, actorHouseholdId: ACTOR_HOUSEHOLD, actorHouseholdContacts: [],
            taHouseholdId: ACTOR_HOUSEHOLD, adult: nameOnly,
        })).toBe(true);
        expect(conflict({ personId: ACTOR, personHouseholdId: ACTOR_HOUSEHOLD })).toBe(true);
    });

    it("refuses another family's adult linked to a person in the actor's household", () => {
        expect(conflict({ personId: 2, personHouseholdId: ACTOR_HOUSEHOLD })).toBe(true);
    });

    it("refuses another family's unlinked adult whose email matches the actor's household", () => {
        expect(conflict({ email: "  spouse@example.COM " })).toBe(true);
    });

    it("refuses another family's unlinked adult whose phone matches the actor's household", () => {
        expect(conflict({ phone: "+1 555.234.5678" })).toBe(true);
    });

    it("refuses a pending change whose proposed contact matches the actor's household", () => {
        expect(conflict({ email: "friend@example.com" }, { email: spouse.email, phone: null })).toBe(true);
    });

    it("judges a linked adult by their household, not by contact details", () => {
        expect(conflict({ personId: 2, personHouseholdId: 30, email: spouse.email })).toBe(false);
    });

    it("passes an adult with no match", () => {
        expect(conflict({ email: "friend@example.com", phone: "555-999-0000" })).toBe(false);
    });

    it("does not block a name-only adult, and flags it as unconfirmed", () => {
        expect(conflict({})).toBe(false);
        expect(cannotConfirmNoConflict(nameOnly)).toBe(true);
        expect(cannotConfirmNoConflict({ ...nameOnly, email: "friend@example.com" })).toBe(false);
        expect(cannotConfirmNoConflict({ ...nameOnly, personId: 2 })).toBe(false);
    });
});
