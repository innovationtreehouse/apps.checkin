/**
 * The page watch itself (support/pageErrors): it must see a red error chip and a red inline
 * alert, or every spec that asserts "no problems" passes a page that shows one.
 */
import { expect, test } from "@playwright/test";
import { addItem, SEEDED_ITEM } from "./support/catalog";
import { watchPage } from "./support/pageErrors";
import { FINANCE, INVENTORY_MANAGER, releaseLibraries, type Undo } from "./support/seedState";
import { signIn } from "./support/session";

const undo: Undo[] = [];
test.beforeAll(async () => {
  undo.push(await releaseLibraries());
});
test.afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

test("the page watch sees a red error chip, once", async ({ browser }) => {
  const { context } = await signIn(browser, INVENTORY_MANAGER);
  const page = await context.newPage();
  const watch = watchPage(page);
  await page.goto("/catalog/items");
  // A name the catalog already has is refused with a red chip that stays, and nothing is written.
  await addItem(page, SEEDED_ITEM);
  await expect(page.locator(".mantine-Notification-root").filter({ hasText: "already exists" })).toBeVisible();
  expect((await watch.problems()).some((p) => p.startsWith("error chip:") && p.includes("already exists"))).toBe(true);
  expect(await watch.problems()).toEqual([]);
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
