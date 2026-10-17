/**
 * @jest-environment node
 */
/**
 * Integration tests for the emergency-contact service against a real database.
 * Covers the not-a-household-member rule in both directions, the partial-save
 * tolerance, the >=1-valid floor, and the admin alarm count.
 */
import prisma from "@/lib/prisma";
import {
    createContact,
    updateContact,
    deleteContact,
    upsertPrimaryContact,
    reconcileHouseholdConflicts,
    reconcileAndWarn,
    householdHasValidContact,
    listValidContacts,
    getPrimaryValidContact,
    countHouseholdsMissingValidContact,
    findHouseholdsMissingValidContact,
    EmergencyContactError,
} from "@/lib/emergencyContacts/service";

const TAG = "ec-service-test";

async function wipe() {
    const tagged = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const hhIds = tagged.map((h) => h.id);
    if (hhIds.length === 0) return;
    await prisma.emergencyContact.deleteMany({ where: { householdId: { in: hhIds } } });
    await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: hhIds } } } });
    await prisma.orgMembership.deleteMany({ where: { householdId: { in: hhIds } } });
    await prisma.person.deleteMany({ where: { householdId: { in: hhIds } } });
    await prisma.household.deleteMany({ where: { id: { in: hhIds } } });
}

async function makeHousehold(suffix: string) {
    const hh = await prisma.household.create({ data: { name: `${TAG}-${suffix}` } });
    return hh.id;
}

async function addMember(householdId: number, data: { name: string; email?: string; phone?: string }) {
    return prisma.person.create({ data: { householdId, ...data } });
}

beforeAll(wipe);
afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe("createContact — direction A (hard)", () => {
    it("allows an external contact", async () => {
        const hh = await makeHousehold("ext");
        await addMember(hh, { name: "Parent One", phone: "555-555-1000" });
        const c = await createContact(prisma, hh, { name: "Aunt May", phone: "555-555-2000" });
        expect(c.id).toBeGreaterThan(0);
        expect(c.phoneDigits).toBe("5555552000");
        expect(c.conflictParticipantId).toBeNull();
    });

    it("rejects a contact matching a member by phone (any format)", async () => {
        const hh = await makeHousehold("phone");
        await addMember(hh, { name: "Parent One", phone: "(555) 555-1000" });
        await expect(createContact(prisma, hh, { name: "Someone Else", phone: "5555551000" })).rejects.toBeInstanceOf(EmergencyContactError);
    });

    it("rejects a contact matching a member by email", async () => {
        const hh = await makeHousehold("email");
        await addMember(hh, { name: "Parent One", email: "shared@x.com", phone: "555-555-1000" });
        await expect(
            createContact(prisma, hh, { name: "Someone Else", phone: "555-555-9999", email: "SHARED@x.com" }),
        ).rejects.toBeInstanceOf(EmergencyContactError);
    });

    it("rejects a contact matching a member by name", async () => {
        const hh = await makeHousehold("name");
        await addMember(hh, { name: "Jane Doe", phone: "555-555-1000" });
        await expect(createContact(prisma, hh, { name: "jane doe", phone: "555-555-9999" })).rejects.toBeInstanceOf(EmergencyContactError);
    });

    it("allows the same phone as a member of a DIFFERENT household", async () => {
        const a = await makeHousehold("cross-a");
        const b = await makeHousehold("cross-b");
        await addMember(a, { name: "Parent A", phone: "555-555-7777" });
        const c = await createContact(prisma, b, { name: "Neighbor", phone: "555-555-7777" });
        expect(c.id).toBeGreaterThan(0);
    });

    it("rejects a blank name or blank phone as incomplete", async () => {
        const hh = await makeHousehold("blank");
        await expect(createContact(prisma, hh, { name: "  ", phone: "555-555-2000" })).rejects.toMatchObject({ code: "incomplete" });
        await expect(createContact(prisma, hh, { name: "Aunt May", phone: "  " })).rejects.toMatchObject({ code: "incomplete" });
    });

    it("rejects a malformed phone number as incomplete", async () => {
        const hh = await makeHousehold("badphone");
        await expect(createContact(prisma, hh, { name: "Aunt May", phone: "123" })).rejects.toMatchObject({ code: "incomplete" });
    });
});

describe("upsertPrimaryContact — partial tolerance + member rejection", () => {
    it("persists a partial contact without the member check", async () => {
        const hh = await makeHousehold("partial");
        await addMember(hh, { name: "Jane Doe", phone: "555-555-1000" });
        // name only, and it equals a member — tolerated because incomplete.
        const c = await upsertPrimaryContact(prisma, hh, { name: "Jane Doe", phone: "" });
        expect(c).not.toBeNull();
        expect(await householdHasValidContact(prisma, hh)).toBe(false);
    });

    it("rejects a complete contact that is a member", async () => {
        const hh = await makeHousehold("upsert-member");
        await addMember(hh, { name: "Jane Doe", phone: "555-555-1000" });
        await expect(upsertPrimaryContact(prisma, hh, { name: "Jane Doe", phone: "555-555-1000" })).rejects.toBeInstanceOf(EmergencyContactError);
    });

    it("persists the optional email + its normalized key", async () => {
        const hh = await makeHousehold("upsert-email");
        const c = await upsertPrimaryContact(prisma, hh, { name: "Aunt May", phone: "555-555-4009", email: "  Aunt.May@Example.COM " });
        expect(c?.email).toBe("Aunt.May@Example.COM");
        expect(c?.emailNorm).toBe("aunt.may@example.com");
    });

    it("updates the same primary row on repeat", async () => {
        const hh = await makeHousehold("upsert-update");
        await upsertPrimaryContact(prisma, hh, { name: "Aunt May", phone: "555-555-2000" });
        await upsertPrimaryContact(prisma, hh, { name: "Aunt May", phone: "555-555-3000" });
        const all = await prisma.emergencyContact.findMany({ where: { householdId: hh } });
        expect(all).toHaveLength(1);
        expect(all[0].phone).toBe("555-555-3000");
    });

    it("rejects a malformed phone even when the name is blank", async () => {
        const hh = await makeHousehold("upsert-badphone");
        await expect(upsertPrimaryContact(prisma, hh, { name: "", phone: "123" })).rejects.toMatchObject({ code: "incomplete" });
    });
});

describe("upsertPrimaryContact — a partial save can't degrade a stored contact", () => {
    it("refuses a blank name and leaves the stored contact untouched", async () => {
        const hh = await makeHousehold("upsert-degrade-name");
        const before = await createContact(prisma, hh, { name: "Aunt May", phone: "555-555-2000", email: "may@example.com" });

        await expect(upsertPrimaryContact(prisma, hh, { name: "", phone: "555-555-2000" })).rejects.toMatchObject({ code: "incomplete" });

        const after = await prisma.emergencyContact.findUnique({ where: { id: before.id } });
        expect(after).toMatchObject({ name: "Aunt May", phone: "555-555-2000", email: "may@example.com" });
        expect(await householdHasValidContact(prisma, hh)).toBe(true);
    });

    it("refuses a blank phone, and an email-only payload can't strip name+phone", async () => {
        const hh = await makeHousehold("upsert-degrade-phone");
        const before = await createContact(prisma, hh, { name: "Aunt May", phone: "555-555-2000" });

        await expect(upsertPrimaryContact(prisma, hh, { name: "Aunt May", phone: "" })).rejects.toMatchObject({ code: "incomplete" });
        // Name and phone absent entirely: the stored values carry, so this is a
        // plain email edit rather than a wipe.
        const updated = await upsertPrimaryContact(prisma, hh, { email: "may@example.com" });
        expect(updated).toMatchObject({ id: before.id, name: "Aunt May", phone: "555-555-2000", email: "may@example.com" });
        expect(await householdHasValidContact(prisma, hh)).toBe(true);
    });

    it("keeps a stored email when the caller collects no email field", async () => {
        const hh = await makeHousehold("upsert-keep-email");
        await upsertPrimaryContact(prisma, hh, { name: "Aunt May", phone: "555-555-2000", email: "may@example.com" });

        const updated = await upsertPrimaryContact(prisma, hh, { name: "Uncle Ben", phone: "555-555-3000" });
        expect(updated).toMatchObject({ name: "Uncle Ben", phone: "555-555-3000", email: "may@example.com", emailNorm: "may@example.com" });
    });

    it("still lets a resumable form build up a partial contact from nothing", async () => {
        const hh = await makeHousehold("upsert-build-up");
        const first = await upsertPrimaryContact(prisma, hh, { name: "Aunt May", phone: "" });
        expect(first).toMatchObject({ name: "Aunt May", phone: "" });
        expect(await householdHasValidContact(prisma, hh)).toBe(false);

        const second = await upsertPrimaryContact(prisma, hh, { phone: "555-555-2000" });
        expect(second).toMatchObject({ id: first!.id, name: "Aunt May", phone: "555-555-2000" });
        expect(await householdHasValidContact(prisma, hh)).toBe(true);
    });
});

describe("getPrimaryValidContact", () => {
    it("returns the valid contact, skipping a flagged one, ordered by priority", async () => {
        const hh = await makeHousehold("primary-valid");
        await createContact(prisma, hh, { name: "Aunt May", phone: "555-555-2000" });
        await addMember(hh, { name: "Aunt May", phone: "555-555-2000" }); // flags May via reconcile below
        await reconcileHouseholdConflicts(prisma, hh);
        const good = await createContact(prisma, hh, { name: "Neighbor Bob", phone: "555-555-4000" });
        const primary = await getPrimaryValidContact(prisma, hh);
        expect(primary?.id).toBe(good.id);
    });

    it("returns null when the household has no valid contact", async () => {
        const hh = await makeHousehold("primary-none");
        expect(await getPrimaryValidContact(prisma, hh)).toBeNull();
    });
});

describe("reconcileHouseholdConflicts — direction B (soft)", () => {
    it("flags a contact when a matching member is added later, then clears on remediation", async () => {
        const hh = await makeHousehold("recon");
        const contact = await createContact(prisma, hh, { name: "Aunt May", phone: "555-555-2000" });
        expect(await householdHasValidContact(prisma, hh)).toBe(true);

        // A new member turns out to be the emergency contact.
        await addMember(hh, { name: "Aunt May", phone: "555-555-2000" });
        const flagged = await reconcileHouseholdConflicts(prisma, hh);
        expect(flagged.map((c) => c.id)).toContain(contact.id);
        expect(await householdHasValidContact(prisma, hh)).toBe(false);

        const after = await prisma.emergencyContact.findUnique({ where: { id: contact.id } });
        expect(after?.conflictParticipantId).not.toBeNull();

        // Remediation: add a real external replacement -> household valid again.
        await createContact(prisma, hh, { name: "Neighbor Bob", phone: "555-555-4000" });
        expect(await householdHasValidContact(prisma, hh)).toBe(true);
        expect((await listValidContacts(prisma, hh)).map((c) => c.name)).toEqual(["Neighbor Bob"]);
    });

    it("reconcileAndWarn returns a warning with hasValidContact=false when the only contact is flagged", async () => {
        const hh = await makeHousehold("warn");
        await createContact(prisma, hh, { name: "Aunt May", phone: "555-555-2000" });
        await addMember(hh, { name: "Aunt May", phone: "555-555-2000" });
        const warning = await reconcileAndWarn(prisma, hh);
        expect(warning).not.toBeNull();
        expect(warning!.code).toBe("EMERGENCY_CONTACT_CONFLICT");
        expect(warning!.hasValidContact).toBe(false);
    });

    it("returns null when nothing changed", async () => {
        const hh = await makeHousehold("noop");
        await createContact(prisma, hh, { name: "Aunt May", phone: "555-555-2000" });
        await addMember(hh, { name: "Unrelated Kid", phone: "555-555-8888" });
        expect(await reconcileAndWarn(prisma, hh)).toBeNull();
    });

    it("clears a stale flag once the colliding member is gone", async () => {
        const hh = await makeHousehold("stale-clear");
        const contact = await createContact(prisma, hh, { name: "Aunt May", phone: "555-555-2000" });
        const member = await addMember(hh, { name: "Aunt May", phone: "555-555-2000" });
        await reconcileHouseholdConflicts(prisma, hh);
        expect((await prisma.emergencyContact.findUnique({ where: { id: contact.id } }))?.conflictParticipantId).toBe(member.id);

        // The colliding member leaves the household — the flag is now stale.
        await prisma.person.delete({ where: { id: member.id } });
        await reconcileHouseholdConflicts(prisma, hh);
        expect((await prisma.emergencyContact.findUnique({ where: { id: contact.id } }))?.conflictParticipantId).toBeNull();
    });

    it("re-points a flag to a new colliding member when the original member is gone", async () => {
        const hh = await makeHousehold("repoint");
        const contact = await createContact(prisma, hh, { name: "Aunt May", phone: "555-555-2000" });
        const memberA = await addMember(hh, { name: "Aunt May", phone: "555-555-2000" });
        await reconcileHouseholdConflicts(prisma, hh);
        expect((await prisma.emergencyContact.findUnique({ where: { id: contact.id } }))?.conflictParticipantId).toBe(memberA.id);

        // Member A leaves, a different member with the SAME identity arrives.
        await prisma.person.delete({ where: { id: memberA.id } });
        const memberB = await addMember(hh, { name: "Aunt May", phone: "555-555-2000" });
        await reconcileHouseholdConflicts(prisma, hh);
        const after = await prisma.emergencyContact.findUnique({ where: { id: contact.id } });
        expect(after?.conflictParticipantId).toBe(memberB.id);
    });

    it("reconcileAndWarn reports hasValidContact=true when another valid contact remains", async () => {
        const hh = await makeHousehold("warn-still-valid");
        await createContact(prisma, hh, { name: "Aunt May", phone: "555-555-2000" });
        await createContact(prisma, hh, { name: "Neighbor Bob", phone: "555-555-4000" });
        await addMember(hh, { name: "Aunt May", phone: "555-555-2000" });
        const warning = await reconcileAndWarn(prisma, hh);
        expect(warning?.hasValidContact).toBe(true);
        expect(warning?.message).toContain("marked invalid");
    });
});

describe("updateContact + deleteContact", () => {
    it("clears a conflict flag when the contact is edited to an external person", async () => {
        const hh = await makeHousehold("update-clear");
        const contact = await createContact(prisma, hh, { name: "Aunt May", phone: "555-555-2000" });
        await addMember(hh, { name: "Aunt May", phone: "555-555-2000" });
        await reconcileHouseholdConflicts(prisma, hh);
        expect(await householdHasValidContact(prisma, hh)).toBe(false);

        await updateContact(prisma, hh, contact.id, { name: "Aunt Maybelle", phone: "555-555-2001" });
        expect(await householdHasValidContact(prisma, hh)).toBe(true);
    });

    it("deletes a contact", async () => {
        const hh = await makeHousehold("del");
        const c = await createContact(prisma, hh, { name: "Temp", phone: "555-555-2000" });
        await deleteContact(prisma, hh, c.id);
        expect(await prisma.emergencyContact.findUnique({ where: { id: c.id } })).toBeNull();
    });
});

describe("countHouseholdsMissingValidContact — admin alarm", () => {
    it("counts only member/in-intake households lacking a valid contact", async () => {
        const baseline = await countHouseholdsMissingValidContact(prisma);

        // In-intake household with a flagged (invalid) contact -> should count.
        const hh = await makeHousehold("alarm-intake");
        const m = await prisma.orgMembership.create({ data: { householdId: hh, status: "NONE" } });
        await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m.id, kind: "INITIAL", status: "INTAKE" } });
        await createContact(prisma, hh, { name: "Aunt May", phone: "555-555-2000" });
        await addMember(hh, { name: "Aunt May", phone: "555-555-2000" });
        await reconcileHouseholdConflicts(prisma, hh);

        // A non-member household with no contact -> should NOT count.
        await makeHousehold("alarm-nonmember");

        expect(await countHouseholdsMissingValidContact(prisma)).toBe(baseline + 1);

        // Remediate -> count returns to baseline.
        await createContact(prisma, hh, { name: "Neighbor Bob", phone: "555-555-4000" });
        expect(await countHouseholdsMissingValidContact(prisma)).toBe(baseline);
    });

    it("also scopes an ACTIVE membership with no in-flight process", async () => {
        const before = await findHouseholdsMissingValidContact(prisma);
        const hh = await makeHousehold("alarm-active");
        await prisma.orgMembership.create({ data: { householdId: hh, status: "ACTIVE" } });
        const after = await findHouseholdsMissingValidContact(prisma);
        expect(after.length).toBe(before.length + 1);
        expect(after).toContain(hh);
    });
});
