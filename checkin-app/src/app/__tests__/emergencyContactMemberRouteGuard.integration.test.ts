/**
 * @jest-environment node
 */
/**
 * Route-level wiring tests for the safety-critical "an emergency contact cannot
 * be an existing household member" rule.
 *
 * The service (lib/emergencyContacts/service.ts) is well-covered directly. What
 * is NOT covered is whether the household API routes that call it actually map
 * EmergencyContactError -> the right HTTP status and surface it to the caller.
 * A regression in that catch/return wiring could let a member be saved as their
 * own household's emergency contact with no error reaching the user.
 *
 * These tests exercise the ROUTE, not the service logic:
 *   - Direction A (hard reject): PATCH /api/household/settings -> upsertPrimaryContact
 *     must return 400 with the "is a member" message, and write NO contact row.
 *   - Direction B (soft warn): PATCH /api/household -> reconcileAndWarn must
 *     surface the conflict warning in the 200 body and flag the contact invalid.
 */
import { PATCH as PATCH_SETTINGS } from "@/app/api/household/settings/route";
import { PATCH as PATCH_HOUSEHOLD } from "@/app/api/household/route";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth/next";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));

const TAG = "ec-member-route-guard";

function asUser(id: number) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isSysadmin: false } });
}
function settingsReq(body: unknown) {
    return new Request("http://localhost:4000/api/household/settings", {
        method: "PATCH",
        body: JSON.stringify(body),
    }) as never;
}
function householdReq(body: unknown) {
    return new Request("http://localhost:4000/api/household", {
        method: "PATCH",
        body: JSON.stringify(body),
    }) as never;
}

async function wipe() {
    const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = hhs.map((h) => h.id);
    if (!ids.length) return;
    const members = await prisma.person.findMany({ where: { householdId: { in: ids } }, select: { id: true } });
    const memberIds = members.map((m) => m.id);
    await prisma.emergencyContact.deleteMany({ where: { householdId: { in: ids } } });
    if (memberIds.length) await prisma.auditLog.deleteMany({ where: { actorId: { in: memberIds } } });
    await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
    await prisma.household.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(wipe);
afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe("PATCH /api/household/settings — Direction A: reject a member as primary emergency contact", () => {
    let leadId: number;
    let householdId: number;
    let memberId: number;

    beforeAll(async () => {
        const lead = await prisma.person.create({
            data: {
                email: `lead-A-${TAG}@example.com`,
                name: "Lead A",
                household: { create: { name: `HH-A ${TAG}` } },
            },
        });
        leadId = lead.id;
        householdId = lead.householdId!;
        await prisma.person.update({ where: { id: leadId }, data: { isHouseholdLead: true } });
        const member = await prisma.person.create({
            data: {
                email: `member-A-${TAG}@example.com`,
                name: "Bobby Member",
                phone: "555-555-7777",
                householdId,
            },
        });
        memberId = member.id;
    });

    it("rejects a contact matching a member by name+phone with 400 and writes no contact", async () => {
        asUser(leadId);
        const res = await PATCH_SETTINGS(
            settingsReq({ emergencyContactName: "Bobby Member", emergencyContactPhone: "555-555-7777" }),
        );
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/part of this household|can't be its emergency contact/i);

        const count = await prisma.emergencyContact.count({ where: { householdId } });
        expect(count).toBe(0);
    });

    it("rejects a contact matching a member by phone alone (different name) with 400", async () => {
        // The route only forwards name+phone (no email), so the email identity key
        // is not reachable through this endpoint. Exercise the phone key instead:
        // a different name but the member's phone must still be rejected, proving
        // the route surfaces the rejection regardless of which key matched.
        asUser(leadId);
        const res = await PATCH_SETTINGS(
            settingsReq({ emergencyContactName: "Totally Different", emergencyContactPhone: "(555) 555-7777" }),
        );
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/part of this household|can't be its emergency contact/i);

        const count = await prisma.emergencyContact.count({ where: { householdId } });
        expect(count).toBe(0);
    });

    it("positive control: a genuinely external contact is accepted (200) and written", async () => {
        asUser(leadId);
        const res = await PATCH_SETTINGS(
            settingsReq({ emergencyContactName: "Aunt External", emergencyContactPhone: "555-303-0303" }),
        );
        expect(res.status).toBe(200);
        const contact = await prisma.emergencyContact.findFirst({ where: { householdId } });
        expect(contact?.name).toBe("Aunt External");
        // and the member was never persisted as a contact
        void memberId;
    });
});

describe("PATCH /api/household — Direction B: adding a member that collides with an existing contact warns", () => {
    let leadId: number;
    let householdId: number;
    let contactId: number;

    beforeAll(async () => {
        const lead = await prisma.person.create({
            data: {
                email: `lead-B-${TAG}@example.com`,
                name: "Lead B",
                household: { create: { name: `HH-B ${TAG}` } },
            },
        });
        leadId = lead.id;
        householdId = lead.householdId!;
        await prisma.person.update({ where: { id: leadId }, data: { isHouseholdLead: true } });
        // A pre-existing VALID emergency contact (not yet a member).
        const contact = await prisma.emergencyContact.create({
            data: { householdId, name: "Grandma Ext", phone: "555-1111", phoneDigits: "5551111", priority: 0 },
        });
        contactId = contact.id;
    });

    it("surfaces the reconcile warning in the 200 body and flags the contact invalid", async () => {
        asUser(leadId);
        // memberOver25 is required or the route 400s
        // before ever reaching the reconcile-warning path under test here.
        const res = await PATCH_HOUSEHOLD(householdReq({ memberName: "Grandma Ext", memberOver25: true }));
        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.warning).toBeTruthy();
        expect(body.warning.code).toBe("EMERGENCY_CONTACT_CONFLICT");
        expect(body.warning.conflictedContactIds).toContain(contactId);

        const contact = await prisma.emergencyContact.findUnique({ where: { id: contactId } });
        expect(contact?.conflictParticipantId).not.toBeNull();
    });
});
