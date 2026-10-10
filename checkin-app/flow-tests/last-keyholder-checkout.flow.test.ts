/**
 * @jest-environment node
 */
/**
 * Flow test: a web checkout, removal or dashboard sign-out of the last recorded
 * keyholder while others are inside offers close, leave or cancel by caller
 * class (docs/rules/attendance-checkin.md, Opening and closing).
 *
 * The seed has no household with a non-keyholder lead and a keyholder member,
 * so the suite makes parent2.family (household1, led by parent.family) a
 * keyholder through the board's roles route, and revokes it after. People are
 * checked in through the board's manual check-in.
 */

import { loginAs, api, type Session } from "./helpers";

type Warning = {
    type: string;
    error: string;
    othersInside: number;
    choices: string[];
    forceCloseToken: string;
    names?: string[];
    keyholders?: { id: number; name: string }[];
};
type Roster = {
    attendance: { id: number; participant: { id: number; isKeyholder: boolean } }[];
    safety: { facilityOpen: boolean };
};

describe("flow: web checkout by the last recorded keyholder", () => {
    let board: Session;
    let keyholder: Session;
    let lead: Session;
    let keyholder2Id: number;
    let leadMemberId: number;
    let otherId: number;
    let childId: number;

    const roster = async () => (await api<Roster>(board, "/api/attendance")).json;
    const visitOf = async (personId: number) => (await roster()).attendance.find(v => v.participant.id === personId);
    const checkIn = async (personId: number) => {
        const res = await api(board, "/api/attendance", { method: "POST", body: JSON.stringify({ type: "MANUAL_CHECKIN", participantId: personId }) });
        expect(res.status).toBe(200);
    };
    const signOut = (session: Session, visitId: number, extra: Record<string, unknown> = {}) =>
        api<Warning & { facilityClosed?: boolean }>(session, "/api/attendance", { method: "DELETE", body: JSON.stringify({ visitId, ...extra }) });

    /** Start every journey from an empty building: the board closes it. */
    async function emptyBuilding() {
        for (const v of (await roster()).attendance.filter(a => !a.participant.isKeyholder)) await signOut(board, v.id);
        for (const v of (await roster()).attendance) {
            const res = await signOut(board, v.id);
            if (res.status === 400 && res.json.type === "close_choice") {
                await signOut(board, v.id, { forceCloseToken: res.json.forceCloseToken, closeChoice: "close" });
            }
        }
        expect((await roster()).attendance).toHaveLength(0);
    }

    beforeAll(async () => {
        board = await loginAs("boardmember@example.com");        // sysadmin + board, not a keyholder
        keyholder = await loginAs("keyholder1@example.com");
        lead = await loginAs("parent.family@example.com");       // household1 lead, not a keyholder
        keyholder2Id = (await loginAs("keyholder2@example.com")).personaId;
        leadMemberId = (await loginAs("parent2.family@example.com")).personaId;
        otherId = (await loginAs("certified.adult@example.com")).personaId;
        childId = (await loginAs("child.family@example.com")).personaId;

        const grant = await api(board, "/api/roles", { method: "PATCH", body: JSON.stringify({ targetUserId: leadMemberId, isKeyholder: true }) });
        expect(grant.status).toBe(200);
    });

    beforeEach(emptyBuilding);

    afterAll(async () => {
        await emptyBuilding();
        await api(board, "/api/roles", { method: "PATCH", body: JSON.stringify({ targetUserId: leadMemberId, isKeyholder: false }) });
    });

    it("1. a keyholder alone checks out and closes, with no warning", async () => {
        await checkIn(keyholder.personaId);
        // The dashboard sign-out, not a scan: a scan here would debounce test 2's scan.
        const res = await signOut(keyholder, (await visitOf(keyholder.personaId))!.id);

        expect(res.status).toBe(200);
        expect(res.json.facilityClosed).toBe(true);
    });

    it("2 and 9. the last keyholder is offered all three choices with names, told no other keyholder is in, and close departs everyone", async () => {
        await checkIn(keyholder.personaId);
        await checkIn(otherId);
        await checkIn(childId);

        const warn = await api<Warning>(keyholder, "/api/scan", { method: "POST", body: JSON.stringify({ participantId: keyholder.personaId }) });
        expect(warn.status).toBe(400);
        expect(warn.json).toMatchObject({ type: "close_choice", othersInside: 2, choices: ["close", "leave", "cancel"] });
        expect(warn.json.names).toHaveLength(2);
        expect(warn.json.error).toContain("No other keyholder is checked in");

        const res = await api<{ facilityClosed: boolean }>(keyholder, "/api/scan", {
            method: "POST",
            body: JSON.stringify({ participantId: keyholder.personaId, forceCloseToken: warn.json.forceCloseToken, closeChoice: "close" }),
        });
        expect(res.json.facilityClosed).toBe(true);
        expect((await roster()).attendance).toHaveLength(0);
    });

    it("3. leave naming keyholder2 departs only the leaver and checks keyholder2 in nowhere", async () => {
        await checkIn(keyholder.personaId);
        await checkIn(otherId);
        const kv = (await visitOf(keyholder.personaId))!;

        const warn = await signOut(keyholder, kv.id);
        expect(warn.status).toBe(400);
        expect(warn.json.keyholders?.map(k => k.id)).toContain(keyholder2Id);

        const res = await signOut(keyholder, kv.id, { forceCloseToken: warn.json.forceCloseToken, closeChoice: "leave", handoverToId: keyholder2Id });
        expect(res.status).toBe(200);
        expect(res.json.facilityClosed).toBe(false);

        const after = await roster();
        expect(after.attendance.map(v => v.participant.id)).toEqual([otherId]);
        expect(after.safety.facilityOpen).toBe(false);
    });

    it("4. a household lead checking out the last keyholder member sees a count, no names, and may only leave", async () => {
        await checkIn(leadMemberId);
        await checkIn(otherId);
        const mv = (await visitOf(leadMemberId))!;

        const warn = await signOut(lead, mv.id);
        expect(warn.status).toBe(400);
        expect(warn.json).toMatchObject({ type: "close_choice", othersInside: 1, choices: ["leave", "cancel"] });
        expect(warn.json).not.toHaveProperty("names");
        expect(warn.json).not.toHaveProperty("keyholders");

        const close = await signOut(lead, mv.id, { forceCloseToken: warn.json.forceCloseToken, closeChoice: "close" });
        expect(close.status).toBe(400);

        const leave = await signOut(lead, mv.id, { forceCloseToken: warn.json.forceCloseToken, closeChoice: "leave" });
        expect(leave.status).toBe(200);
        expect((await roster()).attendance.map(v => v.participant.id)).toEqual([otherId]);
    });

    it("5. a board member who is not a keyholder signs out the last keyholder and closes", async () => {
        await checkIn(keyholder.personaId);
        await checkIn(otherId);
        const kv = (await visitOf(keyholder.personaId))!;

        const warn = await signOut(board, kv.id);
        expect(warn.status).toBe(400);
        expect(warn.json.choices).toEqual(["close", "leave", "cancel"]);
        expect(warn.json.names).toHaveLength(1);

        const res = await signOut(board, kv.id, { forceCloseToken: warn.json.forceCloseToken, closeChoice: "close" });
        expect(res.json.facilityClosed).toBe(true);
        expect((await roster()).attendance).toHaveLength(0);
    });

    it("7. removing the last keyholder's open visit never closes", async () => {
        await checkIn(keyholder.personaId);
        await checkIn(otherId);
        const kv = (await visitOf(keyholder.personaId))!;

        const warn = await api<Warning>(keyholder, `/api/attendance/manual/${kv.id}`, { method: "DELETE", body: JSON.stringify({}) });
        expect(warn.status).toBe(400);
        expect(warn.json.choices).toEqual(["leave", "cancel"]);

        const res = await api(keyholder, `/api/attendance/manual/${kv.id}`, {
            method: "DELETE",
            body: JSON.stringify({ forceCloseToken: warn.json.forceCloseToken, closeChoice: "leave" }),
        });
        expect(res.status).toBe(200);
        expect((await roster()).attendance.map(v => v.participant.id)).toEqual([otherId]);
    });

    it("a confirm from someone other than the person shown the choice is not a confirm", async () => {
        await checkIn(keyholder.personaId);
        await checkIn(otherId);
        const kv = (await visitOf(keyholder.personaId))!;

        const warn = await signOut(keyholder, kv.id);
        const replay = await signOut(board, kv.id, { forceCloseToken: warn.json.forceCloseToken, closeChoice: "close" });

        expect(replay.status).toBe(400);
        expect(replay.json.type).toBe("close_choice");
        expect(await visitOf(keyholder.personaId)).toBeDefined();
    });
});
