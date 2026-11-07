/**
 * Kiosk browser tier: Chromium on the kiosk's own page, served by the shipped image
 * through the kiosk flow harness. Asserts what the door shows, which the flow tier's
 * HTTP assertions cannot see.
 */
import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "../flow-tests/helpers";
import { watchPage, type PageWatch } from "../e2e/support/pageErrors";
import { KIOSK, afterRepeatFilter, badge, kioskShows, linkDown, linkUp, removeKiosk, resetData, startKiosk, waitFor } from "./harness";

let keyholderId: number;
let otherId: number;
let page: Page;
let watch: PageWatch;

const kioskShowsOnly = (ids: number[]) =>
    waitFor(`kiosk view [${ids}]`, async () => (await kioskShows()).join() === [...ids].sort((a, b) => a - b).join());

/** Badges in and waits for this badge's own banner, not one left from the badge before. */
async function badgeAndSee(personId: number, text: string | RegExp): Promise<void> {
    await page.locator("#flash-container").evaluate((el) => el.replaceChildren());
    badge(personId);
    await expect(page.locator("#flash-container")).toContainText(text);
    expect(await watch.problems()).toEqual([]);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
    keyholderId = (await loginAs("keyholder2@example.com")).personaId;
    otherId = (await loginAs("certified.adult@example.com")).personaId;
});

test.beforeEach(async ({ page: p }) => {
    resetData();
    await linkUp();
    await startKiosk("new");
    page = p;
    watch = watchPage(page);
    await page.goto(KIOSK);
    // The wrapper subscribes to the kiosk's events once loaded; badges before that show nothing.
    await expect(page.locator("#local-clock")).not.toBeEmpty();
    expect(await watch.problems()).toEqual([]);
});

test.afterEach(async () => {
    await linkUp();
    await removeKiosk();
});

test.afterAll(linkDown);

test("offline, a badge shows it will sync and the queue count, which clears on reconnect", async () => {
    await badgeAndSee(otherId, "CHECKED IN");
    await afterRepeatFilter();

    await linkDown();
    await badgeAndSee(otherId, /CHECKED OUT — will sync \(1 waiting\)/);
    await expect(page.locator("#queue-badge")).toHaveText("1 queued");
    await kioskShowsOnly([]);

    await linkUp();
    await expect(page.locator("#queue-badge")).toBeHidden({ timeout: 60_000 });
    expect(await watch.problems()).toEqual([]);
});

// A live close comes last: for two minutes after one, the server fences a replayed arrival.
test("badges in and out, and the keyholder leaving is offered the close", async () => {
    await badgeAndSee(otherId, "CHECKED IN");
    await badgeAndSee(keyholderId, "CHECKED IN");
    await afterRepeatFilter();
    await badgeAndSee(otherId, "CHECKED OUT");
    await afterRepeatFilter();
    await badgeAndSee(otherId, "CHECKED IN");
    await kioskShowsOnly([keyholderId, otherId]);

    await afterRepeatFilter();
    await badgeAndSee(keyholderId, "Scan again to close the building");
    await expect(page.locator("#fc-countdown")).toBeVisible();
    await afterRepeatFilter();
    await badgeAndSee(keyholderId, "BUILDING CLOSED");
    await kioskShowsOnly([]);
});
