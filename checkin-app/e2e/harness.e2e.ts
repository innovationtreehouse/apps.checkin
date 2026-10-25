/**
 * The page watch itself (support/pageErrors): it must see a red error chip and a red inline
 * alert, or every spec that asserts "no problems" passes a page that shows one.
 */
import { expect, test } from "@playwright/test";
import { watchPage } from "./support/pageErrors";
import { FINANCE, releaseLibraries, type Undo } from "./support/seedState";
import { signIn } from "./support/session";

/** The seed's open reconciliation row (packages/income/prisma/seed.ts). */
const SEED_PAYOUT = "gid://shopify/ShopifyPaymentsPayout/seed-1";

const undo: Undo[] = [];
test.beforeAll(async () => {
  undo.push(await releaseLibraries());
});
test.afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

test("the page watch sees a red error chip", async ({ browser }) => {
  const { context } = await signIn(browser, FINANCE);
  const page = await context.newPage();
  const watch = watchPage(page);
  await page.goto("/income/reconciliation");
  await page.getByRole("row").filter({ hasText: SEED_PAYOUT }).getByText("Resolve", { exact: true }).click();
  // Dismissing with no reason shows a red chip and sends nothing.
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(page.locator(".mantine-Notification-root").filter({ hasText: "Enter a reason first" })).toBeVisible();
  expect(await watch.problems()).toContain("error chip: Enter a reason first");
  await context.close();
});

test("the page watch sees a red inline alert", async ({ browser }) => {
  const { context } = await signIn(browser, FINANCE);
  const page = await context.newPage();
  const watch = watchPage(page);
  // A receipt that does not exist loads as a red alert on its detail page.
  await page.goto("/receipts/no-such-receipt");
  await expect(page.locator(".mantine-Alert-root")).toBeVisible();
  expect((await watch.problems()).some((p) => p.startsWith("error alert:"))).toBe(true);
  await context.close();
});
