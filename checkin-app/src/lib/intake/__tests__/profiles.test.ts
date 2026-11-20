import { INTAKE_PROFILES, missingRequiredFields } from "@/lib/intake/profiles";

describe("intake profiles registry", () => {
    it("membership-initial requires address + emergencyContact + primaryName + memberAges", () => {
        const req = INTAKE_PROFILES["membership-initial"].requiredAtSubmit;
        expect(req).toEqual(["address", "emergencyContact", "primaryName", "memberAges"]);
    });

    it("program-first-time requires primaryName + emergencyContact + participantDob but NOT address", () => {
        const req = INTAKE_PROFILES["program-first-time"].requiredAtSubmit;
        expect(req).toEqual(expect.arrayContaining(["primaryName", "emergencyContact", "participantDob"]));
        expect(req).not.toContain("address");
        // Address is still shown (collected if offered), just not required.
        expect(INTAKE_PROFILES["program-first-time"].shown).toContain("address");
    });

    it("missingRequiredFields flags empty membership-initial fields in profile order", () => {
        const missing = missingRequiredFields(INTAKE_PROFILES["membership-initial"], {
            addressLine1: null,
            emergencyContacts: [],
            primaryName: null,
        });
        expect(missing.map((m) => m.field)).toEqual(["address", "emergencyContact", "primaryName"]);
    });

    it("membership-initial flags a household member with no age on file", () => {
        const base = {
            addressLine1: "1 Main St",
            addressCity: "Austin",
            addressState: "TX",
            addressPostalCode: "78701",
            emergencyContacts: [{ conflictParticipantId: null, name: "Aunt May", phone: "555-2000" }],
            primaryName: "Primary",
        };
        const adult = { dateOfBirth: null, isDeclaredAdult: true };
        const child = { dateOfBirth: new Date("2015-01-01"), isDeclaredAdult: false };
        const ageless = { dateOfBirth: null, isDeclaredAdult: false };
        const profile = INTAKE_PROFILES["membership-initial"];
        expect(missingRequiredFields(profile, { ...base, members: [adult, child] })).toEqual([]);
        expect(missingRequiredFields(profile, { ...base, members: [adult, ageless] }).map((m) => m.field)).toEqual(["memberAges"]);
    });

    it("missingRequiredFields returns [] when membership-initial is satisfied", () => {
        const missing = missingRequiredFields(INTAKE_PROFILES["membership-initial"], {
            addressLine1: "1 Main St",
            addressCity: "Austin",
            addressState: "TX",
            addressPostalCode: "78701",
            emergencyContacts: [{ conflictParticipantId: null, name: "Aunt May", phone: "555-2000" }],
            primaryName: "Primary",
        });
        expect(missing).toEqual([]);
    });

    it("membership-initial address requires city/state/ZIP, not just street", () => {
        const missing = missingRequiredFields(INTAKE_PROFILES["membership-initial"], {
            addressLine1: "1 Main St",
            emergencyContacts: [{ conflictParticipantId: null, name: "Aunt May", phone: "555-2000" }],
            primaryName: "Primary",
        });
        expect(missing.map((m) => m.field)).toEqual(["address"]);
    });

    it("program-first-time: age-gated enrollee without DOB fails participantDob; none age-gated passes", () => {
        const ctx = {
            emergencyContacts: [{ conflictParticipantId: null, name: "Aunt", phone: "555-2000" }],
            primaryName: "Parent",
        };
        expect(
            missingRequiredFields(INTAKE_PROFILES["program-first-time"], {
                ...ctx,
                participants: [{ ageGated: true, dob: null }],
            }).map((m) => m.field),
        ).toEqual(["participantDob"]);
        expect(
            missingRequiredFields(INTAKE_PROFILES["program-first-time"], {
                ...ctx,
                participants: [{ ageGated: false, dob: null }],
            }),
        ).toEqual([]);
    });
});
