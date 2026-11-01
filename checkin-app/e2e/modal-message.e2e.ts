/**
 * A failure raised while a modal is open shows in the lower right, above the modal, and the modal
 * stays open with what was typed (docs/conventions.md → A person is told what happened in one way).
 * The refused save is the catalog's Add Item form with a name already taken.
 */
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { addItem, field, SEEDED_ITEM } from "./support/catalog";
import { INVENTORY_MANAGER, releaseLibraries, type Undo } from "./support/seedState";
import { signIn } from "./support/session";

/** More presses than the Add Item form has controls, so focus has been round it all. */
const TABS_ROUND_THE_MODAL = 30;

const undo: Undo[] = [];
test.beforeAll(async () => {
  undo.push(await releaseLibraries());
});
test.afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

const messageIn = (page: Page) => page.locator(".mantine-Notification-root").filter({ hasText: "already exists" });

/** Opens the form on /catalog/items at `viewport` and submits a taken name, leaving the refusal on screen. */
async function refusedSave(browser: Browser, viewport: { width: number; height: number }) {
  const { context } = await signIn(browser, INVENTORY_MANAGER);
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  await page.goto("/catalog/items");
  await addItem(page, SEEDED_ITEM);
  const message = messageIn(page);
  await expect(message).toBeVisible();
  return { context, page, message, dialog: page.getByRole("dialog") };
}

/** Whether `message` is what a pointer at its centre would hit, rather than the modal over it. */
const isOnTop = (message: Locator) => message.evaluate((el) => {
  const box = el.getBoundingClientRect();
  return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
});

test.describe("a failure message while a modal is open", () => {
  test("shows above the modal, and closing it leaves the modal and what was typed", async ({ browser }) => {
    const { context, page, message, dialog } = await refusedSave(browser, { width: 1280, height: 800 });
    await expect.poll(() => isOnTop(message)).toBe(true);

    await message.getByRole("button").click();
    await expect(messageIn(page)).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(field(dialog, "Name")).toHaveValue(SEEDED_ITEM);
    await context.close();
  });

  test("at phone width, one tap clears it and the modal's buttons can be used", async ({ browser }) => {
    const { context, page, message, dialog } = await refusedSave(browser, { width: 375, height: 667 });
    await expect.poll(() => isOnTop(message)).toBe(true);

    await message.getByRole("button").click();
    await expect(messageIn(page)).toHaveCount(0);
    await expect(field(dialog, "Name")).toHaveValue(SEEDED_ITEM);
    await dialog.getByRole("button", { name: "Create", exact: true }).click({ trial: true });
    await context.close();
  });

  test("its close button can be reached by keyboard from inside the modal", async ({ browser }) => {
    test.fail(true, "Known gap: the modal holds focus, so Tab never reaches the message's close button. A retry replaces the message.");
    const { context, page, message, dialog } = await refusedSave(browser, { width: 1280, height: 800 });
    try {
      await field(dialog, "Name").focus();
      let reached = false;
      for (let press = 0; press < TABS_ROUND_THE_MODAL && !reached; press++) {
        await page.keyboard.press("Tab");
        reached = await message.evaluate((el) => el.contains(document.activeElement));
      }
      expect(reached).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("focus stays in the modal after a refused save", async ({ browser }) => {
    test.fail(true, "Bug: the submit button's loading state drops focus to the body, so Tab walks the page behind the open modal.");
    const { context, dialog } = await refusedSave(browser, { width: 1280, height: 800 });
    try {
      expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    } finally {
      await context.close();
    }
  });
});
