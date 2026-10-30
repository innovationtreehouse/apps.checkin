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
    let other: Session;
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
    /** A badge in at the door: the only way to open the building. Sent as a
     *  current kiosk (it filters repeat reads itself), so the server's 3 s
     *  debounce for older kiosks never drops it. */
    const badgeIn = async (personId: number) => {
        const res = await api<{ type?: string }>(null, "/api/scan", {
            method: "POST",
            body: JSON.stringify({ participantId: personId, intent: "IN", protocolVersion: 5 }),
        });
        expect(res.status).toBe(200);
        expect(res.json.type).toBe("checkin");
    };
    const signOut = (session: Session, visitId: number, extra: Record<string, unknown> = {}) =>
        api<Warning & { facilityClosed?: boolean }>(session, "/api/attendance", { method: "DELETE", body: JSON.stringify({ visitId, ...extra }) });

    /** Start every journey from an empty building: the board signs everyone out.
     *  Not a keyholder, it may only leave, never close. */
    async function emptyBuilding() {
        for (const v of (await roster()).attendance.filter(a => !a.participant.isKeyholder)) await signOut(board, v.id);
        for (const v of (await roster()).attendance) {
            const res = await signOut(board, v.id);
            if (res.status === 400 && res.json.type === "close_choice") {
                await signOut(board, v.id, { forceCloseToken: res.json.forceCloseToken, closeChoice: "leave" });
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
        other = await loginAs("certified.adult@example.com");
        otherId = other.personaId;
        childId = (await loginAs("child.family@example.com")).personaId;

        // Keyholder goes only to a Key Volunteer who has signed the agreement: grant
        // the role, record the agreement signed by hand, then grant Keyholder.
        const volunteer = await api(board, "/api/roles", { method: "PATCH", body: JSON.stringify({ targetUserId: leadMemberId, isKeyVolunteer: true }) });
        expect(volunteer.status).toBe(200);
        const roles = await api<{ people: { id: number; kvaOpenProcessId: number | null }[] }>(board, "/api/roles");
        const row = roles.json.people.find((p) => p.id === leadMemberId);
        if (row?.kvaOpenProcessId) {
            const signed = await api(board, "/api/membership-ops/applications/external", {
                method: "POST",
                body: JSON.stringify({ processId: row.kvaOpenProcessId, action: "mark-contract" }),
            });
            expect(signed.status).toBe(200);
        }
        const grant = await api(board, "/api/roles", { method: "PATCH", body: JSON.stringify({ targetUserId: leadMemberId, isKeyholder: true }) });
        expect(grant.status).toBe(200);
    });

    beforeEach(emptyBuilding);

    afterAll(async () => {
        await emptyBuilding();
        await api(board, "/api/roles", { method: "PATCH", body: JSON.stringify({ targetUserId: leadMemberId, isKeyholder: false, isKeyVolunteer: false }) });
    });

    it("only a badge at the door opens the building; a keyholder inside can check in someone without their badge", async () => {
        const self = await api(keyholder, "/api/attendance", { method: "POST", body: JSON.stringify({ type: "MANUAL_CHECKIN", participantId: keyholder.personaId }) });
        expect(self.status).toBe(403);
        const backfill = await api(keyholder, "/api/attendance/manual", { method: "POST", body: JSON.stringify({ arrivedAt: new Date(Date.now() - 60_000).toISOString() }) });
        expect(backfill.status).toBe(403);
        expect((await roster()).attendance).toHaveLength(0);

        await badgeIn(keyholder.personaId);
        await checkIn(otherId);
        const inside = (await roster()).attendance.map(v => v.participant.id).sort((a, b) => a - b);
        expect(inside).toEqual([keyholder.personaId, otherId].sort((a, b) => a - b));
    });

    it("1. a keyholder alone checks out and closes, with no warning", async () => {
        await badgeIn(keyholder.personaId);
        // The dashboard sign-out, not a scan: a scan here would debounce test 2's scan.
        const res = await signOut(keyholder, (await visitOf(keyholder.personaId))!.id);

        expect(res.status).toBe(200);
        expect(res.json.facilityClosed).toBe(true);
    });

    it("2 and 9. the last keyholder is offered all three choices with names, told no other keyholder is in, and close departs everyone", async () => {
        await badgeIn(keyholder.personaId);
        await checkIn(otherId);
        await checkIn(childId);

        const warn = await api<Warning>(keyholder, "/api/scan", { method: "POST", body: JSON.stringify({ participantId: keyholder.personaId, protocolVersion: 5 }) });
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
        await badgeIn(keyholder.personaId);
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
        await badgeIn(leadMemberId);
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

    it("5. a board member who is not a keyholder signs out the last keyholder and may only leave", async () => {
        await badgeIn(keyholder.personaId);
        await checkIn(otherId);
        const kv = (await visitOf(keyholder.personaId))!;

        const warn = await signOut(board, kv.id);
        expect(warn.status).toBe(400);
        expect(warn.json.choices).toEqual(["leave", "cancel"]);
        expect(warn.json.names).toHaveLength(1);

        const close = await signOut(board, kv.id, { forceCloseToken: warn.json.forceCloseToken, closeChoice: "close" });
        expect(close.status).toBe(400);
        const res = await signOut(board, kv.id, { forceCloseToken: warn.json.forceCloseToken, closeChoice: "leave" });
        expect(res.json.facilityClosed).toBe(false);
        expect((await roster()).attendance.map(v => v.participant.id)).toEqual([otherId]);
    });

    it("7. removing the last keyholder's open visit never closes", async () => {
        await badgeIn(keyholder.personaId);
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

    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    /** An open visit the person records for themselves, arrived `minutes` ago; returns its arrival. */
    const arrivedAgo = async (session: Session, minutes: number) => {
        const arrivedAt = ago(minutes);
        const res = await api(session, "/api/attendance/manual", { method: "POST", body: JSON.stringify({ arrivedAt }) });
        expect(res.status).toBe(201);
        return arrivedAt;
    };
    const correct = (session: Session, visitId: number, body: Record<string, unknown>) =>
        api<Warning>(session, `/api/attendance/manual/${visitId}`, { method: "PATCH", body: JSON.stringify(body) });
    /** The keyholder opens the building at the door, then corrects their arrival to `minutes` ago. */
    const keyholderArrivedAgo = async (minutes: number) => {
        await badgeIn(keyholder.personaId);
        const kv = (await visitOf(keyholder.personaId))!;
        expect((await correct(keyholder, kv.id, { arrivedAt: ago(minutes) })).status).toBe(200);
    };
    /** The departure of the visit that arrived at `arrivedAt`: earlier journeys leave newer visits. */
    const departureOf = async (session: Session, arrivedAt: string) =>
        (await api<{ visits: { arrivedAt: string; departedAt: string | null }[] }>(session, "/api/profile/visits"))
            .json.visits.find(v => v.arrivedAt === arrivedAt)?.departedAt;

    it("6. a correction closing the last keyholder's visit at a past time departs everyone at it, but not a later arrival", async () => {
        await keyholderArrivedAgo(180);
        const otherArrived = await arrivedAgo(other, 180);
        await checkIn(childId);
        const kv = (await visitOf(keyholder.personaId))!;
        const at = ago(120);

        const warn = await correct(keyholder, kv.id, { departedAt: at });
        expect(warn.status).toBe(400);
        expect(warn.json.choices).toEqual(["close", "leave", "cancel"]);

        const res = await correct(keyholder, kv.id, { departedAt: at, forceCloseToken: warn.json.forceCloseToken, closeChoice: "close" });
        expect(res.status).toBe(200);
        expect(await departureOf(other, otherArrived)).toBe(at);
        expect((await roster()).attendance.map(v => v.participant.id)).toEqual([childId]);
    });

    it("8. a keyholder who closes, then corrects their departure earlier, moves every departure the close set, and the log shows each", async () => {
        await keyholderArrivedAgo(180);
        const otherArrived = await arrivedAgo(other, 180);
        const kv = (await visitOf(keyholder.personaId))!;

        const warn = await signOut(keyholder, kv.id);
        const closed = await signOut(keyholder, kv.id, { forceCloseToken: warn.json.forceCloseToken, closeChoice: "close" });
        expect(closed.json.facilityClosed).toBe(true);
        const original = await departureOf(other, otherArrived);
        expect(original).toEqual(expect.any(String));

        const at = ago(60);
        expect((await correct(keyholder, kv.id, { departedAt: at })).status).toBe(200);
        expect(await departureOf(other, otherArrived)).toBe(at);

        type Log = { oldData: { personId: number; departedAt: string }; newData: { personId: number; departedAt: string; moved?: boolean } };
        const { logs } = (await api<{ logs: Log[] }>(board, `/api/system-status/audit-log?table=FacilityClose&actor=${keyholder.personaId}`)).json;
        const moved = logs.filter(l => l.newData.moved && l.newData.personId === otherId);
        expect(moved[0].oldData.departedAt).toBe(original);
        expect(moved[0].newData.departedAt).toBe(at);
    });

    it("a confirm from someone other than the person shown the choice is refused", async () => {
        await badgeIn(keyholder.personaId);
        await checkIn(otherId);
        const kv = (await visitOf(keyholder.personaId))!;

        const warn = await signOut(keyholder, kv.id);
        const replay = await signOut(board, kv.id, { forceCloseToken: warn.json.forceCloseToken, closeChoice: "close" });

        expect(replay.status).toBe(409);
        expect(await visitOf(keyholder.personaId)).toBeDefined();
    });
});
