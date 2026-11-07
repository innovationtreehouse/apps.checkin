/**
 * Membership renewal in the browser: the Board's renewal window, a member family renewing, and a
 * family already paid for the coming year left alone (docs/rules/membership.md, Renewal). Time
 * moves by the Board's membership-year boundary, put back in afterAll. Every test mints its own
 * family, so a rerun on the same stack starts clean. The dev mocks stand in for signing, consent
 * and payment.
 */
import { expect, test, type Page } from "@playwright/test";
import { api, loginAs } from "../flow-tests/helpers";
import { applicationAtPayment, asViewer, REVIEWER, review, settledFamily } from "./support/families";
import { persona } from "./support/kiosk";
import { inDays } from "./support/programs";
import { BOARD, send } from "./support/seedState";

/** The fresh seed's red prompt on /settings/membership until the Board sets the re-check interval. */
const SETTINGS_ALERTS = /Background-check interval is not set|not yet within renewal window/;
const HOUSEHOLD_FILTER = "Filter by household or participant name, email, or ID";

type GrantYear = { year: number; label: string };

let originalBoundary: string | null = null;

const setBoundary = async (date: string | null) => {
  const saved = await send(await loginAs(BOARD), "PUT", "/api/settings/membership", { perYearVariantClient: true, orgMembershipYearBoundary: date });
  if (saved.status !== 200) throw new Error(`set boundary: ${saved.status}`);
};

/** A boundary a month out puts today inside the two-month renewal window. */
const openWindow = () => setBoundary(inDays(30));

/** The year in progress and, inside the renewal window, the coming year, as the Board's grant buttons name them. */
async function grantYears(): Promise<GrantYear[]> {
  const { json } = await api<{ grantYears: GrantYear[] }>(await loginAs(BOARD), "/api/membership-ops/households");
  return json.grantYears;
}

/** A family through review and both approvals, waiting on payment; returns its application's id. */
async function approvedAtPayment(email: string): Promise<number> {
  const processId = await applicationAtPayment(email);
  await review(BOARD, processId, email);
  await review(REVIEWER, processId, email);
  return processId;
}

const processOf = async (email: string) =>
  (await api<{ process: { id: number } }>(await loginAs(email), "/api/membership")).json.process.id;

const heading = (page: Page, name: string) => page.getByRole("heading", { name });

async function membership(page: Page): Promise<void> {
  await page.goto("/membership");
  await expect(heading(page, "Treehouse Membership")).toBeVisible();
}

async function home(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByText(/Welcome back/)).toBeVisible();
  await page.waitForLoadState("networkidle");
}

async function openRenewals(page: Page): Promise<void> {
  await page.goto("/settings/membership");
  await page.getByRole("button", { name: "Open renewals for all active members" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Open Renewals" }).click();
}

test.describe("membership renewal in the browser", () => {
  test.beforeAll(async () => {
    const { json } = await api<{ settings: { BoardSettings: { orgMembershipYearBoundary: string | null } } }>(await loginAs(BOARD), "/api/settings/membership");
    originalBoundary = json.settings.BoardSettings.orgMembershipYearBoundary;
  });

  test.afterAll(async () => {
    // Renewals the tests opened stay open on every active household; only the boundary goes back.
    await setBoundary(originalBoundary);
  });

  test("R1: renewals can't be opened outside the renewal window", async ({ browser }) => {
    await asViewer(browser, BOARD, async (page) => {
      await page.goto("/settings/membership");
      await page.getByLabel("I understand — let me edit the boundary date").check();
      await page.locator(".mantine-Alert-root").filter({ hasText: "Membership-year boundary" }).locator('input[type="date"]').fill(inDays(120));
      await page.getByRole("button", { name: "Save settings" }).click();
      await expect(page.getByText("Settings saved.")).toBeVisible();

      await openRenewals(page);
      await expect(page.getByText("Renewals can't be opened: not yet within renewal window.")).toBeVisible();
    }, SETTINGS_ALERTS);
  });

  test("R2: a member family renews", async ({ browser }) => {
    await openWindow();
    const email = await settledFamily();
    const initial = await approvedAtPayment(email);
    const [yearInProgress] = await grantYears();
    const { json } = await api<{ household: { id: number } }>(await loginAs(email), "/api/household");
    const granted = await send(await loginAs(BOARD), "POST", "/api/membership-ops/households", {
      householdId: json.household.id,
      year: yearInProgress.year,
      reason: "Paid for the year in progress.",
    });
    expect(granted.status).toBe(200);

    await asViewer(browser, BOARD, async (page) => {
      await openRenewals(page);
      await expect(page.getByText(/^Opened \d+ renewal\(s\)/)).toBeVisible();
    }, SETTINGS_ALERTS);

    await asViewer(browser, email, async (page) => {
      await home(page);
      await expect(page.getByText("Membership renewal due")).toBeVisible();
      await page.getByRole("link", { name: "Renew now" }).click();
      await expect(heading(page, "Time to renew")).toBeVisible();
      await page.getByRole("button", { name: "Renew now" }).click();

      await expect(heading(page, "Sign & start your background check")).toBeVisible();
      await page.getByRole("button", { name: "Sign your membership agreement →" }).click();
      await page.getByRole("button", { name: "Complete signing (DEV)" }).click();
      await expect(page.getByText(/^Signed/)).toBeVisible();
      const [averity] = await Promise.all([page.waitForEvent("popup"), page.getByRole("link", { name: "Consent on Averity →" }).click()]);
      await averity.close();
      await page.getByLabel("I submitted my consent on Averity").check();
      await expect(heading(page, "Membership fee")).toBeVisible();
    });

    const renewal = await processOf(email);
    expect(renewal).not.toBe(initial);
    await review(BOARD, renewal, email);
    await review(REVIEWER, renewal, email);
    expect((await send(await loginAs(email), "POST", "/api/dev/shopify/orders-paid", { processId: renewal })).status).toBe(200);

    await asViewer(browser, email, async (page) => {
      await membership(page);
      await expect(heading(page, "You're a member")).toBeVisible();
      await home(page);
      await expect(page.getByText("Membership renewal due")).toHaveCount(0);
    });
  });

  test("R3: a family already paid for the coming year is not billed again", async ({ browser }) => {
    await openWindow();
    const email = await settledFamily();
    const processId = await approvedAtPayment(email);
    expect((await send(await loginAs(email), "POST", "/api/dev/shopify/orders-paid", { processId })).status).toBe(200);
    const [, comingYear] = await grantYears();
    const { name } = await persona(email);

    await asViewer(browser, BOARD, async (page) => {
      await openRenewals(page);
      await expect(page.getByText(/^Opened \d+ renewal\(s\)/)).toBeVisible();

      await page.goto("/membership-ops/households");
      await page.getByPlaceholder(HOUSEHOLD_FILTER).fill(name);
      const granted = page.getByRole("row").filter({ hasText: name }).getByRole("button", { name: `Granted ${comingYear.label}` });
      await expect(granted).toBeDisabled();
      await expect(granted).toHaveAttribute("title", "This household is already set for this year.");
    }, SETTINGS_ALERTS);

    await asViewer(browser, email, async (page) => {
      await home(page);
      await expect(page.getByText("Membership renewal due")).toHaveCount(0);
      await membership(page);
      await expect(heading(page, "You're a member")).toBeVisible();
    });
  });
});
