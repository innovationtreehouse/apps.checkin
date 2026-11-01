/**
 * Check-in and check-out in the browser: scans go to the server as the kiosk sends them, and the
 * pages show keyholders, members and the Board what they did (docs/rules/attendance-checkin.md).
 * Who is inside and the latest close are global, so the tests run in order and each one ends with
 * a keyholder's one-badge close. Without a kiosk key the roster reads as unconfirmed.
 */
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { toDatetimeLocal } from "@/lib/time";
import { api, loginAs } from "../flow-tests/helpers";
import { runNightly } from "./support/cron";
import { newFamily } from "./support/families";
import { persona, resend, scan } from "./support/kiosk";
import { watchPage } from "./support/pageErrors";
import { BOARD } from "./support/seedState";
import { signIn } from "./support/session";

const KEYHOLDER = "keyholder1@example.com";
const OTHER_KEYHOLDER = "keyholder2@example.com";
const NO_OPEN_VISITS = "No open visits recorded.";
const COLUMNS = ["Keyholders", "Volunteers/Adults", "Students"];

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const nameOf = async (email: string) => (await persona(email)).name;

/** A family checked in at the door, with its name as the pages show it. */
async function checkedIn(): Promise<{ email: string; name: string }> {
  const email = await newFamily();
  expect((await scan(email, { intent: "IN" })).json.type).toBe("checkin");
  return { email, name: await nameOf(email) };
}

/** Runs `steps` on a page signed in as `email`, asserting after them that the page showed no problem. */
async function asViewer(browser: Browser, email: string, steps: (page: Page) => Promise<void>): Promise<void> {
  const { context } = await signIn(browser, email);
  const page = await context.newPage();
  const watch = watchPage(page);
  await steps(page);
  expect(await watch.problems()).toEqual([]);
  await context.close();
}

const roster = async (page: Page) => {
  await page.goto("/attendance/current");
  await expect(page.getByRole("heading", { name: "Current Attendance" })).toBeVisible();
  await expect(page.getByText(/^Checked in \(unconfirmed\): \d+$/)).toBeVisible();
};

const personCard = (page: Page, name: string): Locator => page.locator(".mantine-Paper-root:not(.mantine-Card-root)").filter({ hasText: name });

/** The roster column under this label, if it lists `name`. */
function columnListing(page: Page, label: string, name: string): Locator {
  const others = new RegExp(COLUMNS.filter((c) => c !== label).join("|"));
  return page.locator("div").filter({ has: page.getByText(label, { exact: true }) }).filter({ hasNotText: others }).filter({ hasText: name }).first();
}

/** The closed-out list on the visits page, narrowed to this person's row. */
async function closedOutRow(page: Page, name: string): Promise<Locator> {
  await page.goto("/facility-ops/visits");
  await page.getByText("Closed out by a close").click();
  await page.getByPlaceholder("Filter by name, email, event, or ID...").fill(name);
  return page.getByRole("row").filter({ hasText: name });
}

test.describe.serial("check-in and check-out in the browser", () => {
  // Closes on an empty building are harmless, and nothing in a test depends on the one before it
  // leaving someone inside.
  test.afterEach(async () => {
    expect((await scan(KEYHOLDER, { intent: "OUT", close: "alone" })).json.facilityClosed).toBe(true);
  });

  test("C1: a badge with no keyholder in is marked, and a keyholder within ten minutes clears it", async ({ browser }) => {
    const [early, late] = [await newFamily(), await newFamily()];
    const earlyArrival = await scan(early, { intent: "IN", replay: true, scannedAt: minutesAgo(11) });
    // Any close since this arrival fences it, which a rerun on the same stack meets within 12 minutes.
    test.skip(earlyArrival.json.visit?.facilityCloseId != null, "a close in the last 12 minutes fences the backdated arrivals");
    expect(earlyArrival.json.type).toBe("checkin");
    expect((await scan(late, { intent: "IN", replay: true, scannedAt: minutesAgo(9) })).json.type).toBe("checkin");
    expect((await scan(KEYHOLDER, { intent: "IN" })).json.type).toBe("checkin");

    const [earlyName, lateName] = [await nameOf(early), await nameOf(late)];
    await asViewer(browser, BOARD, async (page) => {
      await roster(page);
      const mark = "Checked in with no keyholder in the building";
      await expect(personCard(page, earlyName).getByTitle(mark)).toBeVisible();
      await expect(personCard(page, lateName)).toBeVisible();
      await expect(personCard(page, lateName).getByTitle(mark)).toHaveCount(0);
    });
  });

  test("C2: a badge in and out shows on the roster and in the member's visits", async ({ browser }) => {
    expect((await scan(KEYHOLDER, { intent: "IN" })).json.type).toBe("checkin");
    const member = await checkedIn();
    const keyholderName = await nameOf(KEYHOLDER);

    await asViewer(browser, BOARD, async (page) => {
      await roster(page);
      await expect(page.getByText("Can't confirm building state")).toBeVisible();
      await expect(columnListing(page, "Keyholders", keyholderName)).toBeVisible();
      // A minted family has no date of birth, and an unknown age counts as a youth.
      await expect(columnListing(page, "Students", member.name)).toBeVisible();

      expect((await scan(member.email, { intent: "OUT" })).json.type).toBe("checkout");
      await roster(page);
      await expect(personCard(page, member.name)).toHaveCount(0);
    });
    await asViewer(browser, member.email, async (page) => {
      await page.goto("/attendance/my-visits");
      await expect(page.getByRole("button", { name: "Edit visit" })).toHaveCount(1);
      await expect(page.getByText("Still checked in")).toHaveCount(0);
    });
  });

  let closeInC3: Date;

  test("C3: a one-badge close ends everyone's visit", async ({ browser }) => {
    expect((await scan(KEYHOLDER, { intent: "IN" })).json.type).toBe("checkin");
    const member = await checkedIn();

    closeInC3 = new Date();
    const close = await scan(KEYHOLDER, { intent: "OUT", close: "alone" });
    expect(close.json).toMatchObject({ message: "Checked out and Facility closed", facilityClosed: true });

    await asViewer(browser, BOARD, async (page) => {
      await roster(page);
      await expect(page.getByText(NO_OPEN_VISITS)).toBeVisible();
      await expect(await closedOutRow(page, member.name)).toContainText("Keyholder");
    });
  });

  test("C4: a close is held for a check-in the kiosk's roster missed, and applies on resend", async ({ browser }) => {
    const rosterAsOf = new Date();
    const member = await checkedIn();
    expect((await scan(OTHER_KEYHOLDER, { intent: "IN" })).json.type).toBe("checkin");

    const held = await scan(OTHER_KEYHOLDER, { intent: "OUT", close: "alone", rosterAsOf });
    expect(held.json.facilityClosed).toBe(false);
    expect(held.json.closePrompt).toContain("Badge again to close the building.");

    await asViewer(browser, BOARD, async (page) => {
      await roster(page);
      await expect(personCard(page, member.name)).toBeVisible();

      const resent = await resend(held.eventId, OTHER_KEYHOLDER, { intent: "OUT", close: "alone", rosterAsOf, replay: true, scannedAt: new Date() });
      expect(resent.json.facilityClosed).toBe(true);
      await roster(page);
      await expect(page.getByText(NO_OPEN_VISITS)).toBeVisible();

      await page.goto("/system-status/unsynced-scans");
      const flagged = page.getByRole("row").filter({ hasText: "building closed from a kiosk roster taken before someone else checked in" });
      await expect(flagged).toHaveCount(1);
      await flagged.getByRole("button", { name: "Dismiss" }).click();
      await expect(flagged).toHaveCount(0);
    });
  });

  test("C5: a close from someone who is not a keyholder is a plain checkout", async ({ browser }) => {
    expect((await scan(KEYHOLDER, { intent: "IN" })).json.type).toBe("checkin");
    const member = await checkedIn();

    const refused = await scan(member.email, { intent: "OUT", close: "alone" });
    expect(refused.json).toMatchObject({ message: "Only a keyholder can close the building.", closeRefused: true, facilityClosed: false });

    const keyholderName = await nameOf(KEYHOLDER);
    await asViewer(browser, BOARD, async (page) => {
      await roster(page);
      // A keyholder of unknown age is also listed under Students, so the name can show twice.
      await expect(personCard(page, keyholderName).first()).toBeVisible();
      await expect(personCard(page, member.name)).toHaveCount(0);
    });
  });

  test("C6: a second badge-in is parked for review, and the Board dismisses it", async ({ browser }) => {
    const member = await checkedIn();
    expect((await scan(member.email, { intent: "IN" })).json.type).toBe("parked");

    await asViewer(browser, BOARD, async (page) => {
      await page.goto("/system-status/unsynced-scans");
      const row = page.getByRole("row").filter({ hasText: member.name });
      await expect(row).toContainText("check-in while already checked in");
      await row.getByRole("button", { name: "Dismiss" }).click();
      await expect(row).toHaveCount(0);
      await page.reload();
      await expect(page.getByText(/Scans Awaiting Review|No scans awaiting review/)).toBeVisible();
      await expect(row).toHaveCount(0);
    });
  });

  test("C7: a queued arrival from before a close departs at that close", async ({ browser }) => {
    const email = await newFamily();
    const arrival = await scan(email, { intent: "IN", replay: true, scannedAt: new Date(closeInC3.getTime() - 1000) });
    expect(arrival.json).toMatchObject({ type: "checkin", message: "Checked in; departed at the close that followed" });

    const name = await nameOf(email);
    await asViewer(browser, BOARD, async (page) => {
      await roster(page);
      await expect(page.getByText(NO_OPEN_VISITS)).toBeVisible();
      await expect(personCard(page, name)).toHaveCount(0);
      await expect(await closedOutRow(page, name)).toContainText("Keyholder");
    });
  });

  test("C8: a queued close that arrives after the nightly pulls the departure back", async ({ browser }) => {
    const member = await checkedIn();
    const scannedAt = new Date();
    await runNightly();

    await asViewer(browser, BOARD, async (page) => {
      await expect(await closedOutRow(page, member.name)).toContainText("Nightly");

      const close = await scan(KEYHOLDER, { intent: "OUT", close: "confirmed", replay: true, scannedAt });
      expect(close.json.facilityClosed).toBe(true);
      await expect(await closedOutRow(page, member.name)).toContainText("Keyholder");
    });

    const { json } = await api<{ visits: Array<{ departedAt: string; person: { name: string } }> }>(await loginAs(BOARD), "/api/facility/visits?closedOut=true");
    const visit = json.visits.find((v) => v.person.name === member.name);
    expect(visit?.departedAt).toBe(scannedAt.toISOString());
  });

  test("C9: the website neither opens nor ends a visit", async ({ browser }) => {
    const email = await newFamily();
    await asViewer(browser, email, async (page) => {
      // Anchored, because the dev panel on this stack has a "+ Check-ins" button.
      const controls = page.getByRole("button", { name: /^check.?(in|out)/i });
      await page.goto("/");
      await expect(controls).toHaveCount(0);
      await page.goto("/attendance/current");
      await expect(page.getByRole("heading", { name: "Current Attendance" })).toBeVisible();
      await expect(controls).toHaveCount(0);

      await page.goto("/attendance/manual");
      await page.getByLabel("Arrival Time (Required)").fill(toDatetimeLocal(minutesAgo(60)));
      await expect(page.getByRole("button", { name: "Record Time Entry" })).toBeDisabled();
    });

    const member = await loginAs(email);
    const scanned = await api<{ error: string }>(member, "/api/scan", { method: "POST", body: JSON.stringify({ participantId: member.personaId, intent: "IN" }) });
    expect(scanned.status).toBe(403);
    expect(scanned.json.error).toBe("Check in at the kiosk.");
    expect((await api(member, "/api/attendance", { method: "POST", body: "{}" })).status).toBe(405);
    const open = await api<{ error: string }>(member, "/api/attendance/manual", { method: "POST", body: JSON.stringify({ arrivedAt: minutesAgo(60).toISOString() }) });
    expect(open.status).toBe(400);
    expect(open.json.error).toContain("Departure time is required");
  });

  test("C10: a member corrects their own closed visit, and the Board sees it", async ({ browser }) => {
    const email = await newFamily();
    const name = await nameOf(email);
    await asViewer(browser, email, async (page) => {
      await page.goto("/attendance/manual");
      // A new family is asked for an emergency contact; skipping lasts for this tab.
      await page.getByRole("button", { name: "Ask me next time" }).click();
      await page.getByLabel("Arrival Time (Required)").fill(toDatetimeLocal(minutesAgo(180)));
      await page.getByLabel("Departure Time (Required)").fill(toDatetimeLocal(minutesAgo(120)));
      await page.getByRole("button", { name: "Record Time Entry" }).click();
      await expect(page.getByText("Visit recorded successfully.")).toBeVisible();

      await page.goto("/attendance/my-visits");
      const row = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Edit visit" }) });
      const before = await row.innerText();
      await row.getByRole("button", { name: "Edit visit" }).click();
      await page.getByLabel("Departure time").fill(toDatetimeLocal(minutesAgo(60)));
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Visit updated.")).toBeVisible();
      await expect(row).not.toHaveText(before);
    });

    await asViewer(browser, BOARD, async (page) => {
      await page.goto("/facility-ops/corrections");
      await page.getByText("Flagged only").click();
      await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(2);
    });
  });

  test("a keyholder is sent back from the Board's visits page", async ({ browser }) => {
    const { context } = await signIn(browser, KEYHOLDER);
    const page = await context.newPage();
    await page.goto("/facility-ops/visits");
    await page.waitForURL((url) => url.pathname === "/");
    await context.close();
  });
});
