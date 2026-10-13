/**
 * @jest-environment node
 */
/**
 * Flow test: at the kiosk, a keyholder closes. An older kiosk's single badge with
 * others recorded inside checks the last keyholder out and offers the close, and
 * a second badge echoing the offer closes; a kiosk that sends close requests
 * closes on the one badge it sent as a close, whoever the server records
 * (docs/rules/attendance-checkin.md, Opening and closing).
 *
 * Under CHECKIN_ENV=local a cookieless request is the keyless kiosk. People are
 * checked in through the board's manual check-in.
 */

import { loginAs, api, type Session } from "./helpers";

type Offer = { type: string; facilityClosed: boolean; forceCloseToken?: string; closePrompt?: string };
type Roster = {
    attendance: { id: number; participant: { id: number; isKeyholder: boolean } }[];
    safety: { facilityOpen: boolean };
};

describe("flow: the last keyholder at the kiosk", () => {
    let board: Session;
    let keyholderId: number;
    let otherId: number;

    const roster = async () => (await api<Roster>(board, "/api/attendance")).json;
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
    const badge = (extra: Record<string, unknown> = {}) =>
        api<Offer>(null, "/api/scan", { method: "POST", body: JSON.stringify({ participantId: keyholderId, intent: "OUT", protocolVersion: 5, ...extra }) });

    /** The board signs out whatever is open, leaving an empty building. Not a
     *  keyholder, it may only leave, never close. */
    async function emptyBuilding() {
        for (const v of (await roster()).attendance) {
            const res = await api<{ type?: string; forceCloseToken?: string }>(board, "/api/attendance", { method: "DELETE", body: JSON.stringify({ visitId: v.id }) });
            if (res.status === 400 && res.json.type === "close_choice") {
                await api(board, "/api/attendance", { method: "DELETE", body: JSON.stringify({ visitId: v.id, forceCloseToken: res.json.forceCloseToken, closeChoice: "leave" }) });
            }
        }
        expect((await roster()).attendance).toHaveLength(0);
    }

    beforeAll(async () => {
        board = await loginAs("boardmember@example.com");
        keyholderId = (await loginAs("keyholder2@example.com")).personaId;
        otherId = (await loginAs("certified.adult@example.com")).personaId;
        await emptyBuilding();
    });

    afterAll(emptyBuilding);

    it("one badge checks the keyholder out and offers the close; a second closes", async () => {
        await badgeIn(keyholderId);
        await checkIn(otherId);

        const offer = await badge();
        expect(offer.status).toBe(200);
        expect(offer.json).toMatchObject({ type: "checkout", facilityClosed: false });
        expect(offer.json.closePrompt).toContain("No other keyholder is checked in");
        expect(offer.json.forceCloseToken).toEqual(expect.any(String));

        // Left: the other person reads as inside a closed facility.
        const left = await roster();
        expect(left.attendance.map(v => v.participant.id)).toEqual([otherId]);
        expect(left.safety.facilityOpen).toBe(false);

        const close = await badge({ forceCloseToken: offer.json.forceCloseToken });
        expect(close.json).toMatchObject({ type: "checkout", facilityClosed: true });
        expect((await roster()).attendance).toHaveLength(0);
    });

    it("a kiosk that sends close requests closes on one badge when it showed nobody else", async () => {
        await checkIn(keyholderId);
        await checkIn(otherId);

        const close = await badge({ protocolVersion: 6, close: "alone" });
        expect(close.json).toMatchObject({ type: "checkout", facilityClosed: true });
        expect(close.json.forceCloseToken).toBeUndefined();
        expect((await roster()).attendance).toHaveLength(0);
    });
});
