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
 * Under CHECKIN_ENV=local a cookieless request is the keyless kiosk.
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
    /** A badge in at the door. Sent as a current kiosk (it filters repeat reads
     *  itself), so the server's 3 s debounce for older kiosks never drops it. */
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

    /** The keyholder closes at the kiosk, sweeping whoever is inside. */
    async function emptyBuilding() {
        if ((await roster()).attendance.length > 0) {
            expect((await badge({ protocolVersion: 6, close: "confirmed" })).status).toBe(200);
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
        await badgeIn(otherId);

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
        await badgeIn(keyholderId);
        await badgeIn(otherId);

        const close = await badge({ protocolVersion: 6, close: "alone" });
        expect(close.json).toMatchObject({ type: "checkout", facilityClosed: true });
        expect(close.json.forceCloseToken).toBeUndefined();
        expect((await roster()).attendance).toHaveLength(0);
    });
});
