/**
 * Income in the browser. Finance and the Board see income; only finance matches payouts and
 * settles problems, recording why (docs/rules/revenue.md → Income). The flow stack has no store
 * mirror or QuickBooks, so the seed's one open reconciliation row is what the screens work on
 * (packages/income/prisma/seed.ts).
 */
import { expect, test } from "@playwright/test";
import { watchPage, type PageWatch } from "./support/pageErrors";
import { BOARD, FINANCE, MEMBER, releaseLibraries, type Undo } from "./support/seedState";
import { signIn } from "./support/session";

const SEED_PAYOUT = "gid://shopify/ShopifyPaymentsPayout/seed-1";
const REASON_FIELD = "Reason (dismiss, exclude, or match a deposit whose amount differs)";

const undo: Undo[] = [];
test.beforeAll(async () => {
  undo.push(await releaseLibraries());
});
test.afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

async function noProblems(watch: PageWatch, where: string): Promise<void> {
  expect([where, await watch.problems()]).toEqual([where, []]);
}

test.describe("income in the browser", () => {
  test("FINANCE opens the payouts page", async ({ browser }) => {
    const { context } = await signIn(browser, FINANCE);
    const page = await context.newPage();
    const watch = watchPage(page);
    await page.goto("/income/payouts");
    await expect(page.getByRole("heading", { name: "Payouts" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await noProblems(watch, "payouts");
    await context.close();
  });

  test("FINANCE settles a reconciliation row and records why", async ({ browser }) => {
    const { context } = await signIn(browser, FINANCE);
    const page = await context.newPage();
    const watch = watchPage(page);
    await page.goto("/income/reconciliation");
    const row = page.getByRole("row").filter({ hasText: SEED_PAYOUT });
    await row.getByText("Resolve", { exact: true }).click();
    await page.getByLabel(REASON_FIELD).fill("E2E: deposited by hand");
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(row).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("row").filter({ hasText: SEED_PAYOUT })).toHaveCount(0);
    await noProblems(watch, "settle a reconciliation row");
    await context.close();
  });

  test("FINANCE excludes a QuickBooks deposit with a reason", async ({ browser }) => {
    const deposit = `e2e-${Date.now()}`;
    const { context } = await signIn(browser, FINANCE);
    const page = await context.newPage();
    const watch = watchPage(page);
    await page.goto("/income/exclusions");
    const exclude = page.getByRole("button", { name: "Exclude permanently" });
    await page.getByLabel("QuickBooks deposit id").fill(deposit);
    await expect(exclude).toBeDisabled();
    await page.getByLabel("Reason", { exact: true }).fill("E2E: not a store payout");
    await exclude.click();
    await expect(page.getByRole("row").filter({ hasText: deposit })).toContainText("E2E: not a store payout");
    await noProblems(watch, "exclude a deposit");
    await context.close();
  });

  test("the Board sees income but cannot settle or exclude", async ({ browser }) => {
    const { context } = await signIn(browser, BOARD);
    const page = await context.newPage();
    const watch = watchPage(page);
    await page.goto("/income/reconciliation");
    await expect(page.getByRole("heading", { name: /Reconciliation/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Run now" })).toHaveCount(0);
    await expect(page.getByText("Resolve", { exact: true })).toHaveCount(0);
    await page.goto("/income/exclusions");
    await expect(page.getByRole("heading", { name: "QuickBooks Exclusions" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Exclude permanently" })).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    await noProblems(watch, "Board views income");
    await context.close();
  });

  test("a plain member is sent away from income", async ({ browser }) => {
    const { context } = await signIn(browser, MEMBER);
    const page = await context.newPage();
    await page.goto("/income/reconciliation");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: /Reconciliation/ })).toHaveCount(0);
    await context.close();
  });

  test("a signed-out visitor is sent away from income", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    for (const path of ["/income/payouts", "/income/reconciliation"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page, path).not.toHaveURL((url) => url.pathname === path);
    }
    await context.close();
  });
});
