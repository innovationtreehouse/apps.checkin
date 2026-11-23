/**
 * @jest-environment node
 */
/**
 * Flow test for tool certification, driven over HTTP against a running dev server with a fresh
 * seed: a tool's certifier certifies a member on it, the member's own certifications list and the
 * tool's roster show it, and the certifier then lowers the level. Refused along the way: a member
 * who is not a certifier, a certifier on a tool they don't certify, a certifier minting another
 * certifier, a certifier certifying their own household, and a target outside any active member
 * household.
 *
 * Personas: tool.certifier@example.com (MAY_CERTIFY_OTHERS on Table Saw only, solo ACTIVE member
 * household), member.pricing@example.com (lead of an ACTIVE member household, no certifications)
 * and certified.adult@example.com (CERTIFIED on Table Saw, in a household with no membership).
 */

import { loginAs, api, type Session } from "./helpers";

type Cert = { personId: number; toolId: number; level: string; tool: { id: number; name: string }; person?: Record<string, unknown> };
type CertList = { ToolStatus: Cert[] };

describe("flow: certify a member on a tool", () => {
    // First hit of each route compiles it under `next dev`, so the test outlasts the 20 s default.
    it("a certifier certifies a member, the member's list shows it, and the refusals hold", async () => {
        const certifier = await loginAs("tool.certifier@example.com");
        const member = await loginAs("member.pricing@example.com");
        const nonCertifier = await loginAs("certified.adult@example.com");

        const tools = await api<{ id: number; name: string }[]>(certifier, "/api/shop/tools");
        expect(tools.status).toBe(200);
        const toolId = (name: string) => {
            const tool = tools.json.find((t) => t.name === name);
            expect(tool).toBeDefined();
            return tool!.id;
        };
        const tableSaw = toolId("Table Saw");
        const drillPress = toolId("Drill Press");

        const certify = (s: Session, personId: number, tool: number, level: string) =>
            api<{ success?: boolean; certification?: Cert; error?: string }>(s, "/api/shop/certifications", {
                method: "POST",
                body: JSON.stringify({ personId, toolId: tool, level }),
            });
        const ownList = async (s: Session) => {
            const res = await api<CertList>(s, "/api/shop/certifications");
            expect(res.status).toBe(200);
            return res.json.ToolStatus;
        };
        const levelOn = async (s: Session, tool: number) => (await ownList(s)).find((c) => c.toolId === tool)?.level;

        expect(await ownList(member)).toEqual([]);

        // A member who is not a certifier on the tool is refused.
        const notCertifier = await certify(nonCertifier, member.personaId, tableSaw, "CERTIFIED");
        expect(notCertifier.status).toBe(403);
        expect(notCertifier.json.error).toMatch(/not authorized to certify/);

        // A certifier is refused on a tool they don't certify.
        expect((await certify(certifier, member.personaId, drillPress, "CERTIFIED")).status).toBe(403);

        // A certifier cannot mint another certifier; only the Board can.
        const mint = await certify(certifier, member.personaId, tableSaw, "MAY_CERTIFY_OTHERS");
        expect(mint.status).toBe(403);
        expect(mint.json.error).toMatch(/Only admins and board members/);

        // A certifier cannot certify anyone in their own household, themself included.
        const self = await certify(certifier, certifier.personaId, tableSaw, "CERTIFIED");
        expect(self.status).toBe(403);
        expect(self.json.error).toMatch(/your own household/);
        expect(await levelOn(certifier, tableSaw)).toBe("MAY_CERTIFY_OTHERS");

        // A target outside any active member household is refused, and keeps their level.
        const outsider = await certify(certifier, nonCertifier.personaId, tableSaw, "BASIC");
        expect(outsider.status).toBe(403);
        expect(outsider.json.error).toMatch(/target must belong to an active member family/);
        expect(await levelOn(nonCertifier, tableSaw)).toBe("CERTIFIED");

        // The refusals left the member uncertified.
        expect(await ownList(member)).toEqual([]);

        // The certifier certifies the member on their tool.
        const granted = await certify(certifier, member.personaId, tableSaw, "CERTIFIED");
        expect(granted.status).toBe(200);
        expect(granted.json.certification).toMatchObject({ personId: member.personaId, toolId: tableSaw, level: "CERTIFIED" });

        // The member's own list shows it, on Table Saw only.
        expect(await ownList(member)).toEqual([
            expect.objectContaining({ personId: member.personaId, toolId: tableSaw, level: "CERTIFIED", tool: { id: tableSaw, name: "Table Saw" } }),
        ]);

        // Any signed-in member can read the tool's roster; it names each person and nothing more.
        const roster = await api<CertList>(nonCertifier, `/api/shop/certifications?toolId=${tableSaw}`);
        expect(roster.status).toBe(200);
        const row = roster.json.ToolStatus.find((c) => c.personId === member.personaId);
        expect(row?.level).toBe("CERTIFIED");
        for (const c of roster.json.ToolStatus) expect(Object.keys(c.person ?? {}).sort()).toEqual(["id", "name"]);

        // The certifier lowers the level; the same row changes rather than a second appearing.
        const lowered = await certify(certifier, member.personaId, tableSaw, "BASIC");
        expect(lowered.status).toBe(200);
        expect(await ownList(member)).toEqual([expect.objectContaining({ toolId: tableSaw, level: "BASIC" })]);
    }, 60_000);
});
