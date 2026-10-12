/**
 * @jest-environment node
 */
/**
 * Flow test: at the kiosk, the last recorded keyholder's single badge with others
 * inside checks them out and offers the close; a second badge echoing the offer
 * closes the facility (docs/rules/attendance-checkin.md, Opening and closing).
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
    const badge = (extra: Record<string, unknown> = {}) =>
        api<Offer>(null, "/api/scan", { method: "POST", body: JSON.stringify({ participantId: keyholderId, intent: "OUT", ...extra }) });

    /** The board closes whatever is open, leaving an empty building. */
    async function emptyBuilding() {
        for (const v of (await roster()).attendance) {
            const res = await api<{ type?: string; forceCloseToken?: string }>(board, "/api/attendance", { method: "DELETE", body: JSON.stringify({ visitId: v.id }) });
            if (res.status === 400 && res.json.type === "close_choice") {
                await api(board, "/api/attendance", { method: "DELETE", body: JSON.stringify({ visitId: v.id, forceCloseToken: res.json.forceCloseToken, closeChoice: "close" }) });
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
        await checkIn(keyholderId);
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
});
