/**
 * @jest-environment node
 */
/**
 * Flow test for household-lead management (CUJS A3), driven over HTTP against a running
 * dev server with a fresh seed: the lead-only actions on household members, leadership,
 * emergency contacts and trusted adults succeed for the household's lead and are refused
 * for a non-lead adult of the same household.
 *
 * Disclosing a trusted adult is deliberately open to any household member (a visitor may
 * raise one), so only the trusted-adult actions that are lead-gated — renew, withdraw,
 * hide — are asserted both ways.
 *
 * Personas: household.lead@example.com (lead of the seeded "Lead Family") and
 * household.partner@example.com (non-lead adult in the same household).
 */

import { loginAs, api } from "./helpers";

const yearsAgo = (n: number) => `${new Date().getUTCFullYear() - n}-06-01`;

describe("flow: household lead manages the household (CUJS A3)", () => {
    it("lead-only actions succeed for the lead and are refused for a non-lead member", async () => {
        const lead = await loginAs("household.lead@example.com");
        const partner = await loginAs("household.partner@example.com");
        const partnerId = partner.personaId;
        const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
        const patch = (body: unknown) => ({ method: "PATCH", body: JSON.stringify(body) });

        // Add a household member.
        const youth = { memberName: "Lead Family Youth", memberDob: yearsAgo(10) };
        expect((await api(partner, "/api/household", patch(youth))).status).toBe(403);
        const added = await api<{ member: { id: number } }>(lead, "/api/household", patch(youth));
        expect(added.status).toBe(200);
        const youthId = added.json.member.id;

        // Edit a household member: a non-lead may edit only themself.
        expect((await api(partner, "/api/household/member", patch({ participantId: youthId, allergies: "peanuts" }))).status).toBe(403);
        expect((await api(partner, "/api/household/member", patch({ participantId: partnerId, allergies: "none" }))).status).toBe(200);
        expect((await api(lead, "/api/household/member", patch({ participantId: youthId, allergies: "peanuts" }))).status).toBe(200);

        // Leadership: only a lead promotes; a youth can't lead; the last lead can't step down.
        expect((await api(partner, "/api/household/lead", post({ participantId: partnerId }))).status).toBe(403);
        expect((await api(partner, "/api/household/lead", { method: "DELETE", body: JSON.stringify({ participantId: lead.personaId }) })).status).toBe(403);
        expect((await api(lead, "/api/household/lead", post({ participantId: youthId }))).status).toBe(400);
        expect((await api(lead, "/api/household/lead", { method: "DELETE", body: JSON.stringify({ participantId: lead.personaId }) })).status).toBe(400);
        expect((await api(lead, "/api/household/lead", post({ participantId: partnerId }))).status).toBe(200);
        expect((await api(lead, "/api/household/lead", { method: "DELETE", body: JSON.stringify({ participantId: partnerId }) })).status).toBe(200);

        // Emergency contacts.
        const contact = { name: "Pat Outside", phone: "555-987-6543" };
        expect((await api(partner, "/api/household/emergency-contacts")).status).toBe(403);
        expect((await api(partner, "/api/household/emergency-contacts", post(contact))).status).toBe(403);
        expect((await api(lead, "/api/household/emergency-contacts", post(contact))).status).toBe(201);
        const contacts = await api<{ contacts: { name: string }[] }>(lead, "/api/household/emergency-contacts");
        expect(contacts.json.contacts.map((c) => c.name)).toContain("Pat Outside");

        // Trusted adults: disclose, then the lead-gated renew / withdraw / hide.
        const disclosed = await api<{ id: number }>(lead, "/api/trusted-adults", post({
            trustedAdultName: "Robin Neighbor",
            trustedAdultPhone: "555-321-7654",
            familyContext: "Next-door neighbor; may pick up the kids after programs.",
        }));
        expect(disclosed.status).toBe(201);
        const ta = `/api/trusted-adults/${disclosed.json.id}`;

        expect((await api(partner, `${ta}/renew`, post({}))).status).toBe(403);
        expect((await api(lead, `${ta}/renew`, post({}))).status).toBe(409); // review already in flight

        expect((await api(partner, `${ta}/withdraw`, post({}))).status).toBe(403);
        expect((await api(lead, `${ta}/withdraw`, post({}))).status).toBe(200);

        expect((await api(partner, `${ta}/hide`, post({}))).status).toBe(403);
        expect((await api(lead, `${ta}/hide`, post({}))).status).toBe(200);
        const mine = await api<{ trustedAdults: { id: number }[] }>(lead, "/api/trusted-adults/mine");
        expect(mine.status).toBe(200);
        expect(mine.json.trustedAdults.map((t) => t.id)).not.toContain(disclosed.json.id);
    });
});
