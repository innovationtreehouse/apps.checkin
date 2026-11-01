/**
 * @jest-environment node
 */
/**
 * Kiosk flow tier: the shipped image against the running server, signing with a
 * throwaway key the server requires. Badges go in through a fake scanner; every
 * assertion reads the server's or the kiosk's HTTP.
 */
import { BASE, api, loginAs, type Session } from "../flow-tests/helpers";
import {
    afterRepeatFilter, badge, kioskHealthy, kioskShows, killAndRestartKiosk, linkDown, linkUp,
    removeKiosk, resetData, startKiosk, stopKiosk, waitFor, watchBanners,
} from "./harness";

type Roster = { attendance: { participant: { id: number } }[] };

describe("kiosk flow: the shipped image", () => {
    let board: Session;
    let keyholderId: number;
    let otherId: number;

    const serverShows = async () =>
        (await api<Roster>(board, "/api/attendance")).json.attendance.map((v) => v.participant.id).sort((a, b) => a - b);
    const sameIds = (a: number[], b: number[]) => [...a].sort((x, y) => x - y).join() === [...b].sort((x, y) => x - y).join();
    const serverShowsOnly = (ids: number[]) => waitFor(`server roster [${ids}]`, async () => sameIds(await serverShows(), ids));
    const kioskShowsOnly = (ids: number[]) => waitFor(`kiosk view [${ids}]`, async () => sameIds(await kioskShows(), ids));

    /** Both people inside, on a kiosk that has seen the server's roster, so it knows the keyholder. */
    async function bothInside() {
        badge(keyholderId);
        await serverShowsOnly([keyholderId]);
        badge(otherId);
        await serverShowsOnly([keyholderId, otherId]);
        await kioskShowsOnly([keyholderId, otherId]);
    }

    beforeAll(async () => {
        board = await loginAs("boardmember@example.com");
        keyholderId = (await loginAs("keyholder2@example.com")).personaId;
        otherId = (await loginAs("certified.adult@example.com")).personaId;
    });

    beforeEach(async () => {
        resetData();
        await linkUp();
    });

    // Each test leaves the building empty, through the kiosk, for the next.
    afterEach(async () => {
        await serverShowsOnly([]);
        await removeKiosk();
    });

    afterAll(linkDown);

    it("the server refuses an unsigned kiosk request", async () => {
        const scan = await fetch(`${BASE}/api/scan`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ participantId: otherId, intent: "IN", protocolVersion: 7 }),
        });
        expect(scan.status).toBe(401);
        expect((await fetch(`${BASE}/api/attendance`)).status).toBe(401);
    });

    // A live close comes last: for two minutes after one, the server fences a replayed
    // arrival, and a just-started kiosk sends even its first scan as a replay.
    it("old image then new on the same /data loses no queued scan", async () => {
        await startKiosk("kiosk-flow:old");
        await linkDown();
        badge(otherId);
        await kioskShowsOnly([otherId]);
        await stopKiosk();

        await startKiosk("kiosk-flow:new");
        await kioskShowsOnly([otherId]);
        await linkUp();
        await serverShowsOnly([otherId]);

        await afterRepeatFilter();
        badge(otherId);
        await serverShowsOnly([]);
    });

    it("an older image runs against a file the new image wrote, and drains its queue", async () => {
        await startKiosk("kiosk-flow:new");
        await linkDown();
        badge(otherId);
        await kioskShowsOnly([otherId]);
        await stopKiosk();

        await startKiosk("kiosk-flow:old");
        await kioskShowsOnly([otherId]);
        await linkUp();
        await serverShowsOnly([otherId]);

        await afterRepeatFilter();
        badge(otherId);
        await serverShowsOnly([]);
    });

    it("offline scans queue, the health check stays good, and they drain on reconnect", async () => {
        await startKiosk("kiosk-flow:new");
        badge(otherId);
        await serverShowsOnly([otherId]);
        await afterRepeatFilter();
        await linkDown();

        const banners = await watchBanners();
        badge(otherId);
        await waitFor("the queued banner", async () => banners.text().includes("will sync"));
        banners.stop();
        await kioskShowsOnly([]);
        expect(await kioskHealthy()).toBe(true);
        expect(await serverShows()).toEqual([otherId]);

        await linkUp();
        await serverShowsOnly([]);
    });

    it("a kill while offline keeps who is inside: the keyholder's badge still leaves and offers the close", async () => {
        await startKiosk("kiosk-flow:new");
        await bothInside();
        await linkDown();

        await killAndRestartKiosk();
        await kioskShowsOnly([keyholderId, otherId]);

        const banners = await watchBanners();
        badge(keyholderId);
        await waitFor("the offline close offer", async () => banners.text().includes("Scan again to close the building"));
        await kioskShowsOnly([otherId]);

        await afterRepeatFilter();
        badge(keyholderId);
        await waitFor("the offline close", async () => banners.text().includes("BUILDING CLOSED"));
        banners.stop();

        await linkUp();
    });

    it("a badge in and out reach the server, signed, and the keyholder is offered the close", async () => {
        await startKiosk("kiosk-flow:new");
        const banners = await watchBanners();
        await bothInside();

        await afterRepeatFilter();
        badge(keyholderId);
        await waitFor("the close offer", async () => banners.text().includes("Scan again to close the building"));
        await serverShowsOnly([otherId]);

        await afterRepeatFilter();
        badge(keyholderId);
        await waitFor("the closed banner", async () => banners.text().includes("BUILDING CLOSED"));
        await serverShowsOnly([]);
        banners.stop();
    });
});
